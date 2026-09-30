import { setTimeout } from 'node:timers/promises'
import { createContainer } from 'awilix'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { afterEach, describe, expect, it } from 'vitest'
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
import { createHandlerGate } from '../api-contracts/fixtures/sseStreamTestApp.ts'
import { apiLqaIssueStreamContract } from '../api-contracts/fixtures/testContracts.ts'
import { TestApiModule } from '../api-contracts/fixtures/testModules.ts'
import { createSSETestServer, type SSETestServerWithResources } from '../sseTestServerFactory.js'

// Holds the autoClose handler mid-stream
const autoCloseGate = createHandlerGate()

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

function settleWithin(promise: Promise<unknown>, ms: number) {
  return Promise.race([promise.then(() => 'settled' as const), setTimeout(ms, 'pending' as const)])
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
  let context: DIContext<object, object> | undefined

  afterEach(async () => {
    await server?.close()
    await context?.destroy()
    server = undefined
    context = undefined
  })

  /**
   * Start a server with the module's routes and an `onClose` hook registered before them, like
   * the DI dispose hook of a service.
   */
  async function startApp(module: AbstractModule<object>) {
    const diContext = new DIContext<object, object>(
      createContainer({ injectionMode: 'PROXY' }),
      {},
      {},
    )
    diContext.registerDependencies({ modules: [module] }, undefined)
    context = diContext

    const onCloseHook = { ran: false }
    const testServer = await createSSETestServer<undefined>(
      (app) => {
        app.addHook('onClose', (_instance, done) => {
          onCloseHook.ran = true
          done()
        })
        diContext.registerRoutes(app)
      },
      {
        configureApp: (app) => {
          app.setValidatorCompiler(validatorCompiler)
          app.setSerializerCompiler(serializerCompiler)
        },
      },
    )
    server = testServer

    return { testServer, onCloseHook }
  }

  it('closes open keepAlive streams, so later onClose hooks still run', async () => {
    const { testServer, onCloseHook } = await startApp(new TestApiModule())
    const client = await SSEHttpClient.connect(testServer.baseUrl, '/api/test/sse-keep-alive')

    expect(client.response.ok).toBe(true)

    await expect(settleWithin(testServer.close(), 2000)).resolves.toBe('settled')
    expect(onCloseHook.ran).toBe(true)

    client.close()
  })

  it('lets an autoClose stream in progress finish before the app closes', async () => {
    const { testServer, onCloseHook } = await startApp(new AutoCloseStreamModule())
    const client = await connectApiSSE(testServer.baseUrl, apiLqaIssueStreamContract, {
      body: { segment: 'hello' },
    })

    await autoCloseGate.reached

    const closing = testServer.close()
    // Still generating: the close waits for the stream, as for any in-flight request
    await expect(settleWithin(closing, 300)).resolves.toBe('pending')

    autoCloseGate.release()
    const received: string[] = []
    for await (const event of client.events()) {
      received.push(event.event)
    }

    expect(received).toEqual(['issue', 'review'])
    // Not held open by the stream's keep-alive socket once the stream has ended
    await expect(settleWithin(closing, 1000)).resolves.toBe('settled')
    expect(onCloseHook.ran).toBe(true)

    client.close()
  })
})
