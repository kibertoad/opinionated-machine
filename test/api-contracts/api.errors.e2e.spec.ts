import { createContainer } from 'awilix'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DIContext, SSEInjectClient } from '../../index.js'
import { createSSETestServer, type SSETestServerWithResources } from '../sseTestServerFactory.js'
import {
  TestApiErrorModule,
  type TestApiErrorModuleControllers,
  TestApiModule,
  type TestApiModuleControllers,
} from './fixtures/testModules.ts'

type TestContext = DIContext<TestApiModuleControllers & TestApiErrorModuleControllers, object>

describe('AbstractApiController — error handling E2E', () => {
  let server: SSETestServerWithResources<{ context: TestContext }>
  let context: TestContext

  beforeEach(async () => {
    const container = createContainer<TestApiModuleControllers & TestApiErrorModuleControllers>({
      injectionMode: 'PROXY',
    })
    context = new DIContext<TestApiModuleControllers & TestApiErrorModuleControllers, object>(
      container,
      {},
      {},
    )
    context.registerDependencies(
      { modules: [new TestApiModule(), new TestApiErrorModule()] },
      undefined,
    )

    server = await createSSETestServer(
      (app) => {
        context.registerRoutes(app)
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

  // ============================================================================
  // sse.respond() — early HTTP response without starting the stream
  // ============================================================================

  describe('sse.respond()', () => {
    it('sends an HTTP response without starting the SSE stream', async () => {
      const response = await server.app.inject({
        method: 'GET',
        url: '/api/error-test/sse-respond',
      })

      expect(response.statusCode).toBe(404)
      expect(JSON.parse(response.body)).toMatchObject({ error: 'not found' })
    })
  })

  // ============================================================================
  // SSE handler that neither starts nor responds
  // ============================================================================

  describe('SSE handler with no start/respond', () => {
    it('returns 500 when SSE handler does not call sse.start() or sse.respond()', async () => {
      const response = await server.app.inject({
        method: 'GET',
        url: '/api/error-test/sse-no-start',
      })

      expect(response.statusCode).toBe(500)
    })
  })

  // ============================================================================
  // SSE pre-start error
  // ============================================================================

  describe('SSE pre-start error', () => {
    it('returns the error httpStatusCode when handler throws before sse.start()', async () => {
      const response = await server.app.inject({
        method: 'GET',
        url: '/api/error-test/sse-pre-error',
      })

      expect(response.statusCode).toBe(422)
      expect(JSON.parse(response.body)).toMatchObject({ message: 'pre-start error' })
    })
  })

  // ============================================================================
  // SSE post-start error
  // ============================================================================

  describe('SSE post-start error', () => {
    it('sends an error SSE event when handler throws after sse.start()', async () => {
      const client = new SSEInjectClient(server.app)
      const conn = await client.connect('/api/error-test/sse-post-error')

      const events = conn.getReceivedEvents()
      expect(events.some((e) => e.event === 'error')).toBe(true)
    })
  })

  // ============================================================================
  // Sync response body validation failure
  // ============================================================================

  describe('response body validation', () => {
    it('returns 500 when handler returns a body that fails schema validation', async () => {
      const response = await server.app.inject({
        method: 'GET',
        url: '/api/error-test/validation-fail',
      })

      expect(response.statusCode).toBe(500)
    })
  })

  // ============================================================================
  // Response header validation
  // ============================================================================

  describe('response header validation', () => {
    it('succeeds when the required response header is present', async () => {
      const response = await server.app.inject({
        method: 'GET',
        url: '/api/error-test/header-ok',
      })

      expect(response.statusCode).toBe(200)
      expect(response.headers['x-api-version']).toBe('1.0')
    })

    it('returns 500 when a required response header is missing', async () => {
      const response = await server.app.inject({
        method: 'GET',
        url: '/api/error-test/header-fail',
      })

      expect(response.statusCode).toBe(500)
    })
  })

  // ============================================================================
  // sse.respond() called after sse.start()
  // ============================================================================

  describe('sse.respond() after sse.start()', () => {
    it('sends an SSE error event when respond is called after start', async () => {
      const client = new SSEInjectClient(server.app)
      const conn = await client.connect('/api/test/sse-respond-after-start')

      expect(conn.getReceivedEvents().some((e) => e.event === 'error')).toBe(true)
    })
  })

  // ============================================================================
  // sse.sendHeaders() before sse.start()
  // ============================================================================

  describe('sse.sendHeaders()', () => {
    it('can call sse.sendHeaders() before starting the stream', async () => {
      const client = new SSEInjectClient(server.app)
      const conn = await client.connect('/api/test/sse-send-headers')

      expect(conn.getReceivedEvents().some((e) => e.event === 'done')).toBe(true)
    })
  })

  // ============================================================================
  // SSE event schema validation failure
  // ============================================================================

  describe('SSE event schema validation', () => {
    it('sends an SSE error event when handler sends data that fails event schema', async () => {
      const client = new SSEInjectClient(server.app)
      const conn = await client.connect('/api/test/sse-invalid-event')

      expect(conn.getReceivedEvents().some((e) => e.event === 'error')).toBe(true)
    })
  })
})
