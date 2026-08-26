import { buildSseContract as buildContract } from '@lokalise/api-contracts'
import { PublicNonRecoverableError } from '@lokalise/node-core'
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

/**
 * Fastify serializes framework-generated error bodies against `schema.response` too, so the
 * schemas a contract declares have to keep those serializable. Without that, declaring a 400
 * or 404 body turns a failed request or a thrown error into a 500.
 */

const errorsContract = buildContract({
  visibility: 'public',
  method: 'get',
  pathResolver: () => '/api/response-schema/errors',
  requestPathParamsSchema: z.object({}),
  requestQuerySchema: z.object({ q: z.string() }),
  requestHeaderSchema: z.object({}),
  responseBodySchemasByStatusCode: {
    400: z.object({ error: z.string(), details: z.array(z.string()) }),
    404: z.object({ error: z.string(), resourceId: z.string() }),
  },
  serverSentEventSchemas: {
    message: z.object({ text: z.string() }),
  },
})

class ErrorsController extends AbstractSSEController<{ errors: typeof errorsContract }> {
  public static contracts = { errors: errorsContract } as const

  public buildSSERoutes(): BuildFastifySSERoutesReturnType<{ errors: typeof errorsContract }> {
    return { errors: this.handleErrors }
  }

  private handleErrors = buildHandler(errorsContract, {
    sse: async (request, sse) => {
      if (request.query.q === 'missing') {
        throw new PublicNonRecoverableError({
          message: 'No such resource',
          errorCode: 'NOT_FOUND',
          httpStatusCode: 404,
        })
      }

      const session = sse.start('autoClose')
      await session.send('message', { text: 'streamed' })
    },
  })
}

const createdContract = buildContract({
  visibility: 'public',
  method: 'get',
  pathResolver: () => '/api/response-schema/created',
  requestPathParamsSchema: z.object({}),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({}),
  successResponseBodySchema: z.object({ result: z.string() }),
  responseBodySchemasByStatusCode: {
    201: z.object({ createdId: z.string() }),
  },
  serverSentEventSchemas: {
    message: z.object({ text: z.string() }),
  },
})

class CreatedController extends AbstractDualModeController<{ created: typeof createdContract }> {
  public static contracts = { created: createdContract } as const

  public buildDualModeRoutes(): BuildFastifyDualModeRoutesReturnType<{
    created: typeof createdContract
  }> {
    return { created: this.handleCreated }
  }

  private handleCreated = buildHandler(createdContract, {
    sync: async (_request, reply) => {
      reply.code(201)
      // handleSyncMode validates every 2xx against successResponseBodySchema
      return await Promise.resolve({ result: 'made' } as never)
    },
    sse: async (_request, sse) => {
      const session = sse.start('autoClose')
      await session.send('message', { text: 'streamed' })
    },
  })
}

describe('SSE route response schema, framework-generated bodies (e2e)', () => {
  let server: SSETestServerWithResources<undefined>

  beforeEach(async () => {
    const errorsController = new ErrorsController({})
    const createdController = new CreatedController({})

    server = await createSSETestServer(
      (app) => {
        app.route(buildFastifyRoute(errorsController, errorsController.buildSSERoutes().errors))
        app.route(
          buildFastifyRoute(createdController, createdController.buildDualModeRoutes().created),
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

  it('returns a request validation failure at the declared status instead of a 500', async () => {
    const response = await server.app.inject({
      method: 'get',
      url: '/api/response-schema/errors',
      headers: { accept: 'text/event-stream' },
    })

    expect(response.statusCode).toBe(400)
    expect(JSON.parse(response.body)).toMatchObject({
      statusCode: 400,
      error: 'Bad Request',
      code: 'FST_ERR_VALIDATION',
    })
  })

  it('returns a thrown error at its own status with the message intact', async () => {
    const response = await server.app.inject({
      method: 'get',
      url: '/api/response-schema/errors?q=missing',
      headers: { accept: 'text/event-stream' },
    })

    expect(response.statusCode).toBe(404)
    expect(JSON.parse(response.body)).toEqual({
      statusCode: 404,
      error: 'Error',
      message: 'No such resource',
    })
  })

  it('serializes a dual-mode sync body sent at a declared non-200 2xx status', async () => {
    const response = await server.app.inject({
      method: 'get',
      url: '/api/response-schema/created',
      headers: { accept: 'application/json' },
    })

    expect(response.statusCode).toBe(201)
    expect(JSON.parse(response.body)).toEqual({ result: 'made' })
  })
})
