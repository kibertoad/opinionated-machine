import { setTimeout } from 'node:timers/promises'
import { createContainer } from 'awilix'
import type { FastifyInstance } from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import {
  AbstractApiController,
  AbstractModule,
  asApiControllerClass,
  buildApiRoute,
  connectApiSSE,
  DIContext,
  type MandatoryNameAndRegistrationPair,
  SSEHttpClient,
} from '../../index.js'
import { createHandlerGate, type HandlerGate } from '../api-contracts/fixtures/sseStreamTestApp.ts'
import { apiLqaIssueStreamContract } from '../api-contracts/fixtures/testContracts.ts'
import {
  TestApiModule,
  type TestApiModuleControllers,
} from '../api-contracts/fixtures/testModules.ts'
import { createSSETestServer, type SSETestServerWithResources } from '../sseTestServerFactory.js'

// Holds the autoClose handler mid-stream; set by the test that uses it
let autoCloseGate: HandlerGate

class AutoCloseStreamController extends AbstractApiController<
  typeof AutoCloseStreamController.contracts
> {
  static contracts = { lqaIssues: apiLqaIssueStreamContract } as const

  readonly routes = {
    lqaIssues: buildApiRoute(
      AutoCloseStreamController.contracts.lqaIssues,
      async (_request, _reply, { sse }) => {
        const session = sse.start('autoClose')
        await session.send('issue', { severity: 'minor' })
        await autoCloseGate.wait()
        await session.send('review', { score: 1 })
      },
    ),
  }
}

class AutoCloseStreamModule extends AbstractModule<object> {
  resolveDependencies(): MandatoryNameAndRegistrationPair<object> {
    return {}
  }

  override resolveControllers(): MandatoryNameAndRegistrationPair<unknown> {
    return { autoCloseStreamController: asApiControllerClass(AutoCloseStreamController) }
  }
}

/**
 * SSE streams still open when the app closes.
 *
 * Fastify closes its HTTP server in an `onClose` hook that runs before any the app registers,
 * and the server waits for every open connection. An open keepAlive stream used to hold
 * `app.close()` until the process was killed, so no `onClose` hook registered after it (the DI
 * container dispose in a service) ever ran.
 */
describe('SSE streams on app close', () => {
  let server: SSETestServerWithResources<undefined> | undefined
  let client: SSEHttpClient | undefined
  const contexts: Array<{ destroy: () => Promise<void> }> = []

  afterEach(async () => {
    client?.close()
    client = undefined
    await server?.close()
    server = undefined
    await Promise.all(contexts.splice(0).map((context) => context.destroy()))
  })

  async function startServer(registerRoutes: (app: FastifyInstance) => void) {
    const onCloseHook = { ran: false }
    server = await createSSETestServer(
      (app) => {
        // Registered before the routes, like the DI dispose hook of a service
        app.addHook('onClose', (_instance, done) => {
          onCloseHook.ran = true
          done()
        })
        registerRoutes(app)
      },
      {
        configureApp: (app) => {
          app.setValidatorCompiler(validatorCompiler)
          app.setSerializerCompiler(serializerCompiler)
        },
      },
    )
    return { server, onCloseHook }
  }

  function closeWithin2s(app: SSETestServerWithResources<undefined>) {
    return Promise.race([
      app.close().then(() => 'closed' as const),
      setTimeout(2000, 'timed out' as const),
    ])
  }

  it('closes open keepAlive streams, so later onClose hooks still run', async () => {
    const context = new DIContext<TestApiModuleControllers, object>(
      createContainer<TestApiModuleControllers>({ injectionMode: 'PROXY' }),
      {},
      {},
    )
    context.registerDependencies({ modules: [new TestApiModule()] }, undefined)
    contexts.push(context)
    const { server: started, onCloseHook } = await startServer((app) => context.registerRoutes(app))

    client = await SSEHttpClient.connect(started.baseUrl, '/api/test/sse-keep-alive')
    expect(client.response.ok).toBe(true)

    await expect(closeWithin2s(started)).resolves.toBe('closed')
    expect(onCloseHook.ran).toBe(true)
    server = undefined
  })

  it('lets an autoClose stream in progress finish before the app closes', async () => {
    autoCloseGate = createHandlerGate()
    const context = new DIContext<object, object>(
      createContainer({ injectionMode: 'PROXY' }),
      {},
      {},
    )
    context.registerDependencies({ modules: [new AutoCloseStreamModule()] }, undefined)
    contexts.push(context)
    const { server: started, onCloseHook } = await startServer((app) => context.registerRoutes(app))

    const streamClient = await connectApiSSE(started.baseUrl, apiLqaIssueStreamContract, {
      body: { segment: 'hello' },
    })
    onTestFinished(() => streamClient.close())
    await autoCloseGate.reached

    const closing = started.close().then(() => 'closed' as const)
    // Still generating: the close waits for the stream, as for any in-flight request
    await expect(Promise.race([closing, setTimeout(300, 'waiting' as const)])).resolves.toBe(
      'waiting',
    )

    autoCloseGate.release()
    const received: string[] = []
    for await (const event of streamClient.events()) {
      received.push(event.event)
    }

    expect(received).toEqual(['issue', 'review'])
    // Not held open by the stream's keep-alive socket once the stream has ended
    await expect(Promise.race([closing, setTimeout(1000, 'timed out' as const)])).resolves.toBe(
      'closed',
    )
    expect(onCloseHook.ran).toBe(true)
    server = undefined
  })
})
