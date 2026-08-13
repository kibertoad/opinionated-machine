import { buildSseContract, defineApiContract, sseBody } from '@lokalise/api-contracts'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod/v4'
import {
  AbstractDualModeController,
  AbstractSSEController,
  type BuildFastifyDualModeRoutesReturnType,
  type BuildFastifySSERoutesReturnType,
  buildFastifyRoute,
  buildHandler,
} from '../../index.js'
import { buildApiRoute } from '../../lib/api-contracts/index.ts'
import { createSSETestServer, type SSETestServerWithResources } from '../sseTestServerFactory.js'

/**
 * Accept-negotiation matrix for SSE-only and dual-mode routes under
 * @fastify/sse 0.6 route kinds.
 *
 * SSE-only routes use kind 'only' (lenient gate): `*` / missing Accept
 * streams, explicit refusal of text/event-stream gets a 406.
 * Dual-mode routes use kind 'manual': the plugin does no negotiation and
 * determineMode() (q-value aware, honors defaultMode) decides sync vs SSE.
 *
 * These tests deliberately send Accept headers the rest of the suite never
 * sends (missing, `*`, `q=0`) — the old `sse: true` (kind 'legacy') setup
 * crashed on several of them.
 */

// ---------------------------------------------------------------------------
// Modern api-contracts fixtures
// ---------------------------------------------------------------------------

const modernSseContract = defineApiContract({
  method: 'get',
  summary: 'Accept matrix — modern SSE-only',
  pathResolver: () => '/api/modern/stream',
  responsesByStatusCode: {
    200: {
      content: {
        'text/event-stream': sseBody({ tick: z.object({ n: z.number() }) }),
      },
    },
  },
})

const modernDualContract = defineApiContract({
  method: 'get',
  summary: 'Accept matrix — modern dual',
  pathResolver: () => '/api/modern/dual',
  responsesByStatusCode: {
    200: {
      content: {
        'application/json': z.object({ source: z.string() }),
        'text/event-stream': sseBody({ tick: z.object({ n: z.number() }) }),
      },
    },
  },
})

const modernDualSseDefaultContract = defineApiContract({
  method: 'get',
  summary: 'Accept matrix — modern dual, SSE default',
  pathResolver: () => '/api/modern/dual-sse-default',
  responsesByStatusCode: {
    200: {
      content: {
        'application/json': z.object({ source: z.string() }),
        'text/event-stream': sseBody({ tick: z.object({ n: z.number() }) }),
      },
    },
  },
})

// ---------------------------------------------------------------------------
// Legacy contract fixtures
// ---------------------------------------------------------------------------

const legacySseContract = buildSseContract({
  method: 'get',
  pathResolver: () => '/api/legacy/stream',
  requestPathParamsSchema: z.object({}),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({}),
  serverSentEventSchemas: { tick: z.object({ n: z.number() }) },
})

const legacyDualContract = buildSseContract({
  method: 'get',
  pathResolver: () => '/api/legacy/dual',
  requestPathParamsSchema: z.object({}),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({}),
  successResponseBodySchema: z.object({ source: z.string() }),
  serverSentEventSchemas: { tick: z.object({ n: z.number() }) },
})

const legacyDualSseDefaultContract = buildSseContract({
  method: 'get',
  pathResolver: () => '/api/legacy/dual-sse-default',
  requestPathParamsSchema: z.object({}),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({}),
  successResponseBodySchema: z.object({ source: z.string() }),
  serverSentEventSchemas: { tick: z.object({ n: z.number() }) },
})

class LegacyStreamController extends AbstractSSEController<{
  stream: typeof legacySseContract
}> {
  buildSSERoutes(): BuildFastifySSERoutesReturnType<{ stream: typeof legacySseContract }> {
    return { stream: this.handleStream }
  }

  private handleStream = buildHandler(legacySseContract, {
    sse: async (_request, sse) => {
      const session = sse.start('autoClose')
      await session.send('tick', { n: 1 })
    },
  })
}

class LegacyDualController extends AbstractDualModeController<{
  dual: typeof legacyDualContract
  dualSseDefault: typeof legacyDualSseDefaultContract
}> {
  buildDualModeRoutes(): BuildFastifyDualModeRoutesReturnType<{
    dual: typeof legacyDualContract
    dualSseDefault: typeof legacyDualSseDefaultContract
  }> {
    return { dual: this.handleDual, dualSseDefault: this.handleDualSseDefault }
  }

  private handleDual = buildHandler(legacyDualContract, {
    sync: async () => ({ source: 'json' }),
    sse: async (_request, sse) => {
      const session = sse.start('autoClose')
      await session.send('tick', { n: 1 })
    },
  })

  private handleDualSseDefault = buildHandler(
    legacyDualSseDefaultContract,
    {
      sync: async () => ({ source: 'json' }),
      sse: async (_request, sse) => {
        const session = sse.start('autoClose')
        await session.send('tick', { n: 1 })
      },
    },
    { defaultMode: 'sse' },
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Accept negotiation E2E (SSE-only and dual-mode)', () => {
  let server: SSETestServerWithResources<undefined>

  beforeAll(async () => {
    const legacyStreamController = new LegacyStreamController({})
    const legacyDualController = new LegacyDualController({})

    server = await createSSETestServer(
      (app) => {
        app.route(
          buildApiRoute(modernSseContract, async (_request, sse) => {
            const session = sse.start('autoClose')
            await session.send('tick', { n: 1 })
          }),
        )
        app.route(
          buildApiRoute(modernDualContract, {
            nonSse: async () => ({ status: 200, body: { source: 'json' } }),
            sse: async (_request, sse) => {
              const session = sse.start('autoClose')
              await session.send('tick', { n: 1 })
            },
          }),
        )
        app.route(
          buildApiRoute(
            modernDualSseDefaultContract,
            {
              nonSse: async () => ({ status: 200, body: { source: 'json' } }),
              sse: async (_request, sse) => {
                const session = sse.start('autoClose')
                await session.send('tick', { n: 1 })
              },
            },
            { defaultMode: 'sse' },
          ),
        )
        for (const routeConfig of Object.values(legacyStreamController.buildSSERoutes())) {
          app.route(buildFastifyRoute(legacyStreamController, routeConfig))
        }
        for (const routeConfig of Object.values(legacyDualController.buildDualModeRoutes())) {
          app.route(buildFastifyRoute(legacyDualController, routeConfig))
        }
      },
      {
        configureApp: (app) => {
          app.setValidatorCompiler(validatorCompiler)
          app.setSerializerCompiler(serializerCompiler)
        },
        setup: () => undefined,
      },
    )
  })

  afterAll(async () => {
    await server.close()
  })

  const inject = (url: string, accept?: string) =>
    server.app.inject({
      method: 'GET',
      url,
      headers: accept === undefined ? {} : { accept },
    })

  describe.each([
    ['modern', '/api/modern/stream'],
    ['legacy', '/api/legacy/stream'],
  ])('SSE-only route (%s path)', (_generation, url) => {
    it('streams when Accept is text/event-stream', async () => {
      const response = await inject(url, 'text/event-stream')
      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain('text/event-stream')
      expect(response.body).toContain('event: tick')
    })

    it('streams when Accept header is missing', async () => {
      const response = await inject(url)
      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain('text/event-stream')
      expect(response.body).toContain('event: tick')
    })

    it('streams when Accept is */*', async () => {
      const response = await inject(url, '*/*')
      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain('text/event-stream')
    })

    it('returns 406 when Accept refuses SSE (application/json)', async () => {
      const response = await inject(url, 'application/json')
      expect(response.statusCode).toBe(406)
    })

    it('returns 406 when Accept rejects SSE explicitly (q=0)', async () => {
      const response = await inject(url, 'text/event-stream;q=0')
      expect(response.statusCode).toBe(406)
    })
  })

  describe.each([
    ['modern', '/api/modern/dual'],
    ['legacy', '/api/legacy/dual'],
  ])('dual-mode route, defaultMode json (%s path)', (_generation, url) => {
    it('returns JSON when Accept is application/json', async () => {
      const response = await inject(url, 'application/json')
      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain('application/json')
      expect(JSON.parse(response.body)).toEqual({ source: 'json' })
    })

    it('streams when Accept is text/event-stream', async () => {
      const response = await inject(url, 'text/event-stream')
      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain('text/event-stream')
      expect(response.body).toContain('event: tick')
    })

    it('returns JSON (default) when Accept header is missing', async () => {
      const response = await inject(url)
      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain('application/json')
      expect(JSON.parse(response.body)).toEqual({ source: 'json' })
    })

    it('returns JSON (default) when Accept is */*', async () => {
      const response = await inject(url, '*/*')
      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain('application/json')
    })

    it('prefers SSE when q-values rank it higher', async () => {
      const response = await inject(url, 'application/json;q=0.5, text/event-stream;q=0.9')
      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain('text/event-stream')
    })
  })

  describe.each([
    ['modern', '/api/modern/dual-sse-default'],
    ['legacy', '/api/legacy/dual-sse-default'],
  ])('dual-mode route, defaultMode sse (%s path)', (_generation, url) => {
    it('streams when Accept header is missing', async () => {
      const response = await inject(url)
      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain('text/event-stream')
      expect(response.body).toContain('event: tick')
    })

    it('streams when Accept is */* (crashed under kind legacy)', async () => {
      const response = await inject(url, '*/*')
      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain('text/event-stream')
    })

    it('still returns JSON when Accept explicitly asks for application/json', async () => {
      const response = await inject(url, 'application/json')
      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain('application/json')
    })
  })
})
