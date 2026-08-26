import { buildSseContract as buildContract } from '@lokalise/api-contracts'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  AbstractDualModeController,
  AbstractSSEController,
  type BuildFastifyDualModeRoutesReturnType,
  type BuildFastifySSERoutesReturnType,
  buildFastifyRoute,
  buildHandler,
  parseSSEEvents,
} from '../../index.js'
import { createSSETestServer, type SSETestServerWithResources } from '../sseTestServerFactory.js'

/**
 * Runtime counterpart to the `schema.response` unit tests: populating the response schema
 * puts Fastify's serializer in the path for every status code the contract declares, so
 * these assert the streaming and JSON branches still behave, and that a declared status is
 * now serialized against its contract schema rather than plain `JSON.stringify`.
 */

const streamContract = buildContract({
  visibility: 'public',
  method: 'get',
  pathResolver: (params: { mode: string }) => `/api/response-schema/${params.mode}/stream`,
  requestPathParamsSchema: z.object({ mode: z.string() }),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({}),
  responseBodySchemasByStatusCode: {
    404: z.object({ error: z.string() }),
  },
  serverSentEventSchemas: {
    message: z.object({ text: z.string() }),
  },
})

class StreamController extends AbstractSSEController<{ stream: typeof streamContract }> {
  public static contracts = { stream: streamContract } as const

  public buildSSERoutes(): BuildFastifySSERoutesReturnType<{ stream: typeof streamContract }> {
    return { stream: this.handleStream }
  }

  private handleStream = buildHandler(streamContract, {
    sse: async (request, sse) => {
      if (request.params.mode === 'missing') {
        // `leaked` is not in the contract's 404 schema
        return sse.respond(404, { error: 'Not found', leaked: 'secret' } as never)
      }

      const session = sse.start('autoClose')
      await session.send('message', { text: 'streamed' })
    },
  })
}

const dualModeContract = buildContract({
  visibility: 'public',
  method: 'get',
  pathResolver: () => '/api/response-schema/dual',
  requestPathParamsSchema: z.object({}),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({}),
  successResponseBodySchema: z.object({ result: z.string() }),
  serverSentEventSchemas: {
    message: z.object({ text: z.string() }),
  },
})

class DualModeController extends AbstractDualModeController<{ dual: typeof dualModeContract }> {
  public static contracts = { dual: dualModeContract } as const

  public buildDualModeRoutes(): BuildFastifyDualModeRoutesReturnType<{
    dual: typeof dualModeContract
  }> {
    return { dual: this.handleDual }
  }

  private handleDual = buildHandler(dualModeContract, {
    // `leaked` is not in the contract's successResponseBodySchema
    sync: async () => await Promise.resolve({ result: 'ok', leaked: 'secret' } as never),
    sse: async (_request, sse) => {
      const session = sse.start('autoClose')
      await session.send('message', { text: 'streamed' })
    },
  })
}

describe('SSE route response schema (e2e)', () => {
  let server: SSETestServerWithResources<undefined>

  beforeEach(async () => {
    const streamController = new StreamController({})
    const dualModeController = new DualModeController({})

    server = await createSSETestServer(
      (app) => {
        app.route(buildFastifyRoute(streamController, streamController.buildSSERoutes().stream))
        app.route(
          buildFastifyRoute(dualModeController, dualModeController.buildDualModeRoutes().dual),
        )
      },
      {
        configureApp: (app) => {
          app.setValidatorCompiler(validatorCompiler)
          app.setSerializerCompiler(serializerCompiler)
        },
      },
    )
  })

  afterEach(async () => {
    await server.close()
  })

  it('still streams events with a 200 text/event-stream schema declared', async () => {
    const response = await server.app.inject({
      method: 'get',
      url: '/api/response-schema/ok/stream',
      headers: { accept: 'text/event-stream' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/event-stream')

    const events = parseSSEEvents(response.body)
    expect(events).toHaveLength(1)
    expect(events[0]?.event).toBe('message')
    expect(JSON.parse(events[0]!.data)).toEqual({ text: 'streamed' })
  })

  it('serializes an sse.respond() body against the contract schema for that status', async () => {
    const response = await server.app.inject({
      method: 'get',
      url: '/api/response-schema/missing/stream',
      headers: { accept: 'text/event-stream' },
    })

    expect(response.statusCode).toBe(404)
    expect(response.headers['content-type']).toContain('application/json')
    // The undeclared `leaked` key is dropped by the serializer
    expect(JSON.parse(response.body)).toEqual({ error: 'Not found' })
  })

  it('serializes a dual-mode sync body against successResponseBodySchema', async () => {
    const response = await server.app.inject({
      method: 'get',
      url: '/api/response-schema/dual',
      headers: { accept: 'application/json' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('application/json')
    expect(JSON.parse(response.body)).toEqual({ result: 'ok' })
  })

  it('still streams the dual-mode SSE branch', async () => {
    const response = await server.app.inject({
      method: 'get',
      url: '/api/response-schema/dual',
      headers: { accept: 'text/event-stream' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/event-stream')

    const events = parseSSEEvents(response.body)
    expect(events).toHaveLength(1)
    expect(JSON.parse(events[0]!.data)).toEqual({ text: 'streamed' })
  })
})
