import { createContainer } from 'awilix'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DIContext, parseSSEEvents } from '../../index.js'
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
