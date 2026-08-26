import { buildSseContract } from '@lokalise/api-contracts'
import { createContainer } from 'awilix'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  AbstractSSEController,
  type BuildFastifySSERoutesReturnType,
  buildFastifyRoute,
  buildHandler,
  DIContext,
  parseSSEEvents,
  type SSERouteHandler,
} from '../../index.js'
import {
  TestChatDualModeModule,
  TestDefaultModeDualModeModule,
} from '../dualmode/fixtures/testModules.js'
import { createSSETestServer, type SSETestServerWithResources } from '../sseTestServerFactory.js'
import { TestDeferredHeaders404Module, TestPostSSEModule } from './fixtures/testModules.js'

/**
 * Regression tests for https://github.com/kibertoad/opinionated-machine/issues/231
 *
 * Routes used to be registered with `sse: true`, which resolves to the `@fastify/sse`
 * `'legacy'` kind and applies a strict `Accept` gate: unless the client sent an explicit
 * `text/event-stream` token, `reply.sse` was left undefined while the SSE handler still
 * ran, so the first `sse.start()` threw and the request 500'd.
 *
 * Clients that hit this: anything sending a wildcard Accept header (most non-browser HTTP
 * clients), `Accept: application/json`, or no `Accept` header at all (clients generated from
 * the route's OpenAPI spec, since the contract declares no `Accept` parameter).
 */

/**
 * Minimal SSE route used by the `kind` tests below, registered directly through
 * `buildFastifyRoute` so a single contract can be re-registered under different kinds.
 */
const onlyKindContract = buildSseContract({
  visibility: 'public',
  method: 'get',
  pathResolver: (params) => `/api/only-kind/${params.id}/stream`,
  requestPathParamsSchema: z.object({ id: z.string() }),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({}),
  serverSentEventSchemas: { message: z.object({ text: z.string() }) },
  responseBodySchemasByStatusCode: { 404: z.object({ error: z.string() }) },
})

type OnlyKindContracts = { stream: typeof onlyKindContract }

class OnlyKindController extends AbstractSSEController<OnlyKindContracts> {
  public static contracts = { stream: onlyKindContract } as const

  private readonly handler: SSERouteHandler<typeof onlyKindContract>

  constructor(handler: SSERouteHandler<typeof onlyKindContract>) {
    super({})
    this.handler = handler
  }

  public buildSSERoutes(): BuildFastifySSERoutesReturnType<OnlyKindContracts> {
    return { stream: this.handler }
  }
}

const NON_SSE_ACCEPT_HEADERS: [name: string, headers: Record<string, string>][] = [
  ['Accept: */*', { accept: '*/*' }],
  ['Accept: application/json', { accept: 'application/json' }],
  ['no Accept header', {}],
  ['Accept: text/event-stream', { accept: 'text/event-stream' }],
]

describe('SSE-only routes ignore the Accept header (issue #231)', () => {
  let server: SSETestServerWithResources<{ context: DIContext<object, object> }>
  let context: DIContext<object, object>

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies(
      { modules: [new TestPostSSEModule(), new TestDeferredHeaders404Module()] },
      undefined,
    )

    server = await createSSETestServer(
      (app) => {
        context.registerSSERoutes(app)
      },
      {
        configureApp: (app) => {
          app.setValidatorCompiler(validatorCompiler)
          app.setSerializerCompiler(serializerCompiler)
        },
        setup: () => ({ context }),
      },
    )
  })

  afterEach(async () => {
    await server.resources.context.destroy()
    await server.close()
  })

  it.each(NON_SSE_ACCEPT_HEADERS)(
    'streams a POST SSE route with %s',
    { timeout: 10000 },
    async (_name, headers) => {
      const response = await server.app.inject({
        method: 'post',
        url: '/api/chat/completions',
        headers: { 'content-type': 'application/json', ...headers },
        payload: { message: 'Hello World', stream: true },
      })

      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain('text/event-stream')

      const events = parseSSEEvents(response.body)
      const chunkEvents = events.filter((event) => event.event === 'chunk')

      expect(chunkEvents).toHaveLength(2)
      expect(JSON.parse(chunkEvents[0]!.data)).toEqual({ content: 'Hello' })
      expect(JSON.parse(chunkEvents[1]!.data)).toEqual({ content: 'World' })
    },
  )

  it.each(NON_SSE_ACCEPT_HEADERS)(
    'streams a GET SSE route with %s',
    { timeout: 10000 },
    async (_name, headers) => {
      const response = await server.app.inject({
        method: 'get',
        url: '/api/deferred/existing-123/stream',
        headers,
      })

      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain('text/event-stream')

      const events = parseSSEEvents(response.body)
      expect(events).toHaveLength(1)
      expect(JSON.parse(events[0]!.data)).toEqual({ text: 'Found entity existing-123' })
    },
  )

  it.each(NON_SSE_ACCEPT_HEADERS)(
    'serves sse.respond() early returns with %s',
    { timeout: 10000 },
    async (_name, headers) => {
      const response = await server.app.inject({
        method: 'get',
        url: '/api/deferred/missing-999/stream',
        headers,
      })

      expect(response.statusCode).toBe(404)
      expect(response.headers['content-type']).toContain('application/json')
      expect(JSON.parse(response.body)).toEqual({ error: 'Entity not found', id: 'missing-999' })
    },
  )
})

describe('Dual-mode routes negotiate the Accept header themselves (issue #231)', () => {
  let server: SSETestServerWithResources<{ context: DIContext<object, object> }>
  let context: DIContext<object, object>

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies(
      { modules: [new TestChatDualModeModule(), new TestDefaultModeDualModeModule()] },
      undefined,
    )

    server = await createSSETestServer(
      (app) => {
        context.registerDualModeRoutes(app)
      },
      {
        configureApp: (app) => {
          app.setValidatorCompiler(validatorCompiler)
          app.setSerializerCompiler(serializerCompiler)
        },
        setup: () => ({ context }),
      },
    )
  })

  afterEach(async () => {
    await server.resources.context.destroy()
    await server.close()
  })

  it.each([
    ['Accept: */*', { accept: '*/*' }],
    ['no Accept header', {}],
  ])(
    'streams when defaultMode is sse and the client sends %s',
    { timeout: 10000 },
    async (_name, headers) => {
      const response = await server.app.inject({
        method: 'post',
        url: '/api/default-mode-test',
        headers: { 'content-type': 'application/json', ...headers },
        payload: { input: 'test' },
      })

      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain('text/event-stream')

      const events = parseSSEEvents(response.body)
      expect(events).toHaveLength(1)
      expect(JSON.parse(events[0]!.data)).toEqual({ value: 'SSE: test' })
    },
  )

  it.each([
    ['Accept: */*', { accept: '*/*' }],
    ['Accept: application/json', { accept: 'application/json' }],
    ['no Accept header', {}],
  ])(
    'returns JSON when defaultMode is json and the client sends %s',
    { timeout: 10000 },
    async (_name, headers) => {
      const response = await server.app.inject({
        method: 'post',
        url: '/api/chat/completions',
        headers: { 'content-type': 'application/json', ...headers },
        payload: { message: 'Hello World' },
      })

      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain('application/json')
      expect(JSON.parse(response.body)).toEqual({
        reply: 'Echo: Hello World',
        usage: { tokens: 2 },
      })
    },
  )

  it('still streams when the client asks for text/event-stream', { timeout: 10000 }, async () => {
    const response = await server.app.inject({
      method: 'post',
      url: '/api/chat/completions',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      payload: { message: 'Hello World' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/event-stream')

    const events = parseSSEEvents(response.body)
    expect(events.filter((event) => event.event === 'chunk')).toHaveLength(2)
  })
})

/**
 * `kind: 'only'` hands the `Accept` gate to @fastify/sse, which is lenient about wildcards
 * and a missing header but rejects every other concrete media type - `application/json`
 * included. These tests pin that down, because it is easy to read "SSE-only" as "406 only
 * for clients that explicitly refuse SSE".
 */
describe("SSE-only routes registered with kind: 'only'", () => {
  let server: SSETestServerWithResources<undefined>

  beforeEach(async () => {
    const handler = buildHandler(
      onlyKindContract,
      {
        sse: async (request, sse) => {
          if (request.params.id === 'missing') {
            return sse.respond(404, { error: 'Entity not found' })
          }
          const session = sse.start('autoClose')
          await session.send('message', { text: `Found ${request.params.id}` })
        },
      },
      { kind: 'only' },
    )

    server = await createSSETestServer(
      (app) => {
        app.route(buildFastifyRoute(new OnlyKindController(handler), handler))
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

  it.each([
    ['Accept: text/event-stream', { accept: 'text/event-stream' }],
    ['Accept: */*', { accept: '*/*' }],
    ['Accept: text/*', { accept: 'text/*' }],
    ['no Accept header', {}],
  ])('admits %s', { timeout: 10000 }, async (_name, headers) => {
    const response = await server.app.inject({
      method: 'get',
      url: '/api/only-kind/present/stream',
      headers,
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/event-stream')
  })

  it.each([
    ['Accept: application/json', { accept: 'application/json' }],
    ['Accept: text/event-stream;q=0', { accept: 'text/event-stream;q=0' }],
  ])('rejects %s with 406 before the handler runs', { timeout: 10000 }, async (_name, headers) => {
    const response = await server.app.inject({
      method: 'get',
      url: '/api/only-kind/present/stream',
      headers,
    })

    expect(response.statusCode).toBe(406)
    expect(JSON.parse(response.body)).toMatchObject({ error: 'Not Acceptable' })
  })

  it(
    'makes sse.respond() early returns unreachable for JSON clients',
    { timeout: 10000 },
    async () => {
      // The same route under the default kind: 'manual' answers this with a 404 body.
      const response = await server.app.inject({
        method: 'get',
        url: '/api/only-kind/missing/stream',
        headers: { accept: 'application/json' },
      })

      expect(response.statusCode).toBe(406)
    },
  )
})

/**
 * The supported `kind` values keep `reply.sse` attached for every request that reaches an
 * SSE-only handler, but a JavaScript caller can still hand the plugin a gating kind. When
 * that happens the failure must report the real error rather than a second TypeError raised
 * while tearing down a stream that was never set up.
 */
describe('SSE-only route whose plugin gate withheld reply.sse', () => {
  let server: SSETestServerWithResources<undefined>

  beforeEach(async () => {
    const handler = buildHandler(onlyKindContract, {
      sse: async (_request, sse) => {
        const session = sse.start('autoClose')
        await session.send('message', { text: 'never reached' })
      },
    })

    server = await createSSETestServer(
      (app) => {
        const routeOptions = buildFastifyRoute(new OnlyKindController(handler), handler)
        // 'dual' is not assignable to FastifySSERouteOptions['kind'] - reach past the type
        // to reproduce what an untyped caller can still configure.
        app.route({ ...routeOptions, sse: { kind: 'dual' } } as typeof routeOptions)
      },
      {
        configureApp: (app) => {
          app.setValidatorCompiler(validatorCompiler)
          app.setSerializerCompiler(serializerCompiler)
        },
        serverOptions: { logger: false },
      },
    )
  })

  afterEach(async () => {
    await server.close()
  })

  it('reports the original failure instead of masking it', { timeout: 10000 }, async () => {
    const response = await server.app.inject({
      method: 'get',
      url: '/api/only-kind/present/stream',
      headers: { accept: '*/*' },
    })

    expect(response.statusCode).toBe(500)

    const body = JSON.parse(response.body)
    // The first reply.sse dereference in start() is onClose(); that is the error the client
    // must see. Before the fix, the teardown path re-read reply.sse.isConnected from inside
    // its own catch and replaced this with "Cannot read properties of undefined (reading
    // 'isConnected')".
    expect(body.message).toContain('onClose')
    expect(body.message).not.toContain('isConnected')
  })
})
