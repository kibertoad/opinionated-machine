import FastifySSEPlugin from '@fastify/sse'
import { buildSseContract, defineApiContract, sseBody } from '@lokalise/api-contracts'
import { createContainer } from 'awilix'
import fastify, { type FastifyInstance } from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod/v4'
import {
  AbstractModule,
  AbstractSSEController,
  asSSEControllerClass,
  type BuildFastifySSERoutesReturnType,
  buildFastifyRoute,
  buildHandler,
  type DependencyInjectionOptions,
  DIContext,
  type MandatoryNameAndRegistrationPair,
  SSEHttpClient,
  SSETestServer,
} from '../../index.js'
import { buildApiRoute } from '../../lib/api-contracts/index.ts'

/**
 * Per-route heartbeat E2E under @fastify/sse 0.6.
 *
 * The plugin only supports a plugin-level heartbeat interval; route-level
 * intervals are implemented by a framework-managed timer (the plugin's own
 * heartbeat is disabled per route via `heartbeat: false`). These tests pin:
 * - route-level intervals actually emit heartbeats (previously a silent no-op),
 * - `heartbeatInterval: false` silences a route even when the plugin-level
 *   heartbeat is fast,
 * - registration-time intervals (DIContext.registerSSERoutes options —
 *   previously written to a config location the plugin never read) work,
 * - the plugin-level default still applies to routes without overrides.
 *
 * Server A runs the plugin heartbeat at 60s, so any heartbeat observed within
 * the sub-second test window must come from the framework timer.
 * Server B runs the plugin heartbeat at 100ms to prove disabling works.
 */

const modernFrameworkContract = defineApiContract({
  method: 'get',
  summary: 'Heartbeat — modern framework timer',
  pathResolver: () => '/hb/framework-modern',
  responsesByStatusCode: {
    200: { content: { 'text/event-stream': sseBody({ tick: z.object({ n: z.number() }) }) } },
  },
})

const modernDisabledContract = defineApiContract({
  method: 'get',
  summary: 'Heartbeat — disabled',
  pathResolver: () => '/hb/disabled',
  responsesByStatusCode: {
    200: { content: { 'text/event-stream': sseBody({ tick: z.object({ n: z.number() }) }) } },
  },
})

const modernPluginDefaultContract = defineApiContract({
  method: 'get',
  summary: 'Heartbeat — plugin default',
  pathResolver: () => '/hb/plugin-default',
  responsesByStatusCode: {
    200: { content: { 'text/event-stream': sseBody({ tick: z.object({ n: z.number() }) }) } },
  },
})

const legacyFrameworkContract = buildSseContract({
  method: 'get',
  pathResolver: () => '/hb/framework-legacy',
  requestPathParamsSchema: z.object({}),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({}),
  serverSentEventSchemas: { tick: z.object({ n: z.number() }) },
})

const registrationContract = buildSseContract({
  method: 'get',
  pathResolver: () => '/hb/registration',
  requestPathParamsSchema: z.object({}),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({}),
  serverSentEventSchemas: { tick: z.object({ n: z.number() }) },
})

class LegacyHeartbeatController extends AbstractSSEController<{
  stream: typeof legacyFrameworkContract
}> {
  buildSSERoutes(): BuildFastifySSERoutesReturnType<{ stream: typeof legacyFrameworkContract }> {
    return { stream: this.handleStream }
  }

  private handleStream = buildHandler(
    legacyFrameworkContract,
    {
      sse: (_request, sse) => {
        sse.start('keepAlive')
      },
    },
    { heartbeatInterval: 100 },
  )
}

class RegistrationHeartbeatController extends AbstractSSEController<{
  stream: typeof registrationContract
}> {
  buildSSERoutes(): BuildFastifySSERoutesReturnType<{ stream: typeof registrationContract }> {
    return { stream: this.handleStream }
  }

  private handleStream = buildHandler(registrationContract, {
    sse: (_request, sse) => {
      sse.start('keepAlive')
    },
  })
}

class RegistrationHeartbeatModule extends AbstractModule {
  resolveDependencies() {
    return {}
  }

  override resolveControllers(
    diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<unknown> {
    return {
      registrationHeartbeatController: asSSEControllerClass(RegistrationHeartbeatController, {
        diOptions,
      }),
    }
  }
}

async function startServer(
  pluginHeartbeatMs: number,
  registerRoutes: (app: FastifyInstance) => void,
): Promise<SSETestServer> {
  const app = fastify()
  await app.register(FastifySSEPlugin as unknown as Parameters<typeof app.register>[0], {
    heartbeatInterval: pluginHeartbeatMs,
  })
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  registerRoutes(app)
  return SSETestServer.start(app)
}

/**
 * Connect to a keepAlive SSE route and count `: heartbeat` comment frames
 * observed within the given window.
 */
async function countHeartbeats(baseUrl: string, path: string, windowMs: number): Promise<number> {
  const client = await SSEHttpClient.connect(baseUrl, path)
  let count = 0
  client.onRawChunk = (chunk) => {
    count += chunk.split(': heartbeat').length - 1
  }
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), windowMs)
  try {
    for await (const _event of client.events(abort.signal)) {
      // no data events are expected — iterating drains the stream so
      // onRawChunk observes heartbeat comment frames
    }
  } finally {
    clearTimeout(timer)
    client.close()
  }
  return count
}

describe('SSE heartbeat E2E', () => {
  describe('framework-managed route-level heartbeats (plugin heartbeat at 60s)', () => {
    let server: SSETestServer
    let context: DIContext<object, object>

    beforeAll(async () => {
      const container = createContainer({ injectionMode: 'PROXY' })
      context = new DIContext<object, object>(container, {}, {})
      context.registerDependencies({ modules: [new RegistrationHeartbeatModule()] }, undefined)

      const legacyController = new LegacyHeartbeatController({})
      server = await startServer(60_000, (app) => {
        app.route(
          buildApiRoute(
            modernFrameworkContract,
            (_request, sse) => {
              sse.start('keepAlive')
            },
            { heartbeatInterval: 100 },
          ),
        )
        for (const routeConfig of Object.values(legacyController.buildSSERoutes())) {
          app.route(buildFastifyRoute(legacyController, routeConfig))
        }
        context.registerSSERoutes(app, { heartbeatInterval: 100 })
      })
    })

    afterAll(async () => {
      await context.destroy()
      await server.close()
    })

    it('modern route with heartbeatInterval: 100 emits framework heartbeats', async () => {
      const count = await countHeartbeats(server.baseUrl, '/hb/framework-modern', 550)
      expect(count).toBeGreaterThanOrEqual(2)
    })

    it('legacy route with heartbeatInterval: 100 emits framework heartbeats', async () => {
      const count = await countHeartbeats(server.baseUrl, '/hb/framework-legacy', 550)
      expect(count).toBeGreaterThanOrEqual(2)
    })

    it('registration-time heartbeatInterval (registerSSERoutes options) emits heartbeats', async () => {
      const count = await countHeartbeats(server.baseUrl, '/hb/registration', 550)
      expect(count).toBeGreaterThanOrEqual(2)
    })
  })

  describe('disabling and plugin defaults (plugin heartbeat at 100ms)', () => {
    let server: SSETestServer

    beforeAll(async () => {
      server = await startServer(100, (app) => {
        app.route(
          buildApiRoute(
            modernDisabledContract,
            (_request, sse) => {
              sse.start('keepAlive')
            },
            { heartbeatInterval: false },
          ),
        )
        app.route(
          buildApiRoute(modernPluginDefaultContract, (_request, sse) => {
            sse.start('keepAlive')
          }),
        )
      })
    })

    afterAll(async () => {
      await server.close()
    })

    it('heartbeatInterval: false silences the route despite a fast plugin heartbeat', async () => {
      const count = await countHeartbeats(server.baseUrl, '/hb/disabled', 550)
      expect(count).toBe(0)
    })

    it('routes without overrides still get the plugin-level heartbeat', async () => {
      const count = await countHeartbeats(server.baseUrl, '/hb/plugin-default', 550)
      expect(count).toBeGreaterThanOrEqual(2)
    })
  })
})
