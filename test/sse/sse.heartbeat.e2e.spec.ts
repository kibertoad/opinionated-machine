import { setTimeout as delay } from 'node:timers/promises'
import { buildSseContract } from '@lokalise/api-contracts'
import { createContainer } from 'awilix'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  AbstractModule,
  AbstractSSEController,
  asSSEControllerClass,
  type BuildFastifySSERoutesReturnType,
  buildHandler,
  type DependencyInjectionOptions,
  DIContext,
  type MandatoryNameAndRegistrationPair,
  type RegisterSSERoutesOptions,
} from '../../index.js'
import { createSSETestServer, type SSETestServerWithResources } from '../sseTestServerFactory.js'

/**
 * `@fastify/sse` only exposes a boolean `heartbeat` per route — the interval itself is a
 * plugin-registration option shared by every route. These tests pin that contract down:
 * a route (or a whole registration) opting out with `heartbeat: false` must emit no
 * heartbeat comments, while the default keeps emitting them.
 */

// Short enough that a handful of heartbeats land well within the assertion window.
const HEARTBEAT_INTERVAL = 20

const defaultHeartbeatContract = buildSseContract({
  visibility: 'public',
  method: 'get',
  pathResolver: () => '/api/heartbeat/default',
  requestPathParamsSchema: z.object({}),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({}),
  serverSentEventSchemas: { message: z.object({ text: z.string() }) },
})

const disabledHeartbeatContract = buildSseContract({
  visibility: 'public',
  method: 'get',
  pathResolver: () => '/api/heartbeat/disabled',
  requestPathParamsSchema: z.object({}),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({}),
  serverSentEventSchemas: { message: z.object({ text: z.string() }) },
})

type HeartbeatContracts = {
  defaultHeartbeat: typeof defaultHeartbeatContract
  disabledHeartbeat: typeof disabledHeartbeatContract
}

class HeartbeatSSEController extends AbstractSSEController<HeartbeatContracts> {
  public static contracts = {
    defaultHeartbeat: defaultHeartbeatContract,
    disabledHeartbeat: disabledHeartbeatContract,
  } as const

  buildSSERoutes(): BuildFastifySSERoutesReturnType<HeartbeatContracts> {
    return {
      defaultHeartbeat: this.handleDefaultHeartbeat,
      disabledHeartbeat: this.handleDisabledHeartbeat,
    }
  }

  private handleDefaultHeartbeat = buildHandler(defaultHeartbeatContract, {
    sse: (_request, sse) => {
      sse.start('keepAlive')
    },
  })

  private handleDisabledHeartbeat = buildHandler(
    disabledHeartbeatContract,
    {
      sse: (_request, sse) => {
        sse.start('keepAlive')
      },
    },
    { heartbeat: false },
  )
}

class HeartbeatSSEModule extends AbstractModule<object> {
  resolveDependencies(): MandatoryNameAndRegistrationPair<object> {
    return {}
  }

  override resolveControllers(
    diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<unknown> {
    return {
      heartbeatSSEController: asSSEControllerClass(HeartbeatSSEController, { diOptions }),
    }
  }
}

/**
 * Opens a raw SSE connection and returns everything the server wrote within `durationMs`,
 * including heartbeat comment lines (which an event-level client would discard).
 */
async function collectRawStream(url: string, durationMs: number): Promise<string> {
  const abortController = new AbortController()
  const response = await fetch(url, {
    headers: { accept: 'text/event-stream' },
    signal: abortController.signal,
  })
  const body = response.body
  expect(body).toBeTruthy()

  const reader = (body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let received = ''

  const readLoop = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        received += decoder.decode(value, { stream: true })
      }
    } catch {
      // Expected once the connection is aborted below.
    }
  })()

  await delay(durationMs)
  abortController.abort()
  await readLoop

  return received
}

describe('SSE heartbeat E2E', () => {
  let server: SSETestServerWithResources<{ context: DIContext<object, object> }>

  async function startServer(registerOptions?: RegisterSSERoutesOptions) {
    const container = createContainer<object>({ injectionMode: 'PROXY' })
    const context = new DIContext<object, object>(container, {}, {})
    context.registerDependencies({ modules: [new HeartbeatSSEModule()] }, undefined)

    server = await createSSETestServer(
      (app) => {
        context.registerSSERoutes(app, registerOptions)
      },
      {
        configureApp: (app) => {
          app.setValidatorCompiler(validatorCompiler)
          app.setSerializerCompiler(serializerCompiler)
        },
        setup: () => ({ context }),
        ssePluginOptions: { heartbeatInterval: HEARTBEAT_INTERVAL },
      },
    )
  }

  afterEach(async () => {
    await server.resources.context.destroy()
    await server.close()
  })

  describe('per-route heartbeat option', () => {
    beforeEach(async () => {
      await startServer()
    })

    it('emits heartbeat comments by default', async () => {
      const received = await collectRawStream(`${server.baseUrl}/api/heartbeat/default`, 300)

      expect(received).toContain(': heartbeat')
    })

    it('emits no heartbeat comments when the route sets heartbeat: false', async () => {
      const received = await collectRawStream(`${server.baseUrl}/api/heartbeat/disabled`, 300)

      expect(received).not.toContain(': heartbeat')
    })
  })

  describe('registration-level heartbeat option', () => {
    it('disables heartbeats for routes that do not set their own value', async () => {
      await startServer({ heartbeat: false })

      const received = await collectRawStream(`${server.baseUrl}/api/heartbeat/default`, 300)

      expect(received).not.toContain(': heartbeat')
    })

    it('does not override a route that sets heartbeat itself', async () => {
      await startServer({ heartbeat: true })

      const received = await collectRawStream(`${server.baseUrl}/api/heartbeat/disabled`, 300)

      expect(received).not.toContain(': heartbeat')
    })
  })
})
