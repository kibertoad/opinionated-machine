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
  // Early HTTP response from an SSE-capable handler (no stream started)
  // ============================================================================

  describe('early HTTP response', () => {
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
  // SSE handler that neither starts nor returns a response
  // ============================================================================

  describe('SSE handler with no start/response', () => {
    it('returns 500 when SSE handler neither calls sse.start() nor returns { status, body }', async () => {
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
    it('returns the error statusCode when handler throws before sse.start()', async () => {
      const response = await server.app.inject({
        method: 'GET',
        url: '/api/error-test/sse-pre-error',
      })

      expect(response.statusCode).toBe(422)
      expect(JSON.parse(response.body)).toMatchObject({ message: 'pre-start error' })
    })
  })

  // ============================================================================
  // Mid-stream SSE failures — pin the current silent behavior
  //
  // Since the migration to @lokalise/fastify-api-contracts, errors thrown after
  // sse.start() no longer produce a terminal `error` SSE event; the stream just
  // ends with HTTP 200 and only the events sent before the throw. This is
  // documented in the changeset — these tests exist so a future peer bump that
  // changes the behavior (in either direction) is noticed.
  // ============================================================================

  describe('SSE post-start error', () => {
    it('ends the stream silently: 200, only pre-throw events, no error event', async () => {
      const client = new SSEInjectClient(server.app)
      const conn = await client.connect('/api/error-test/sse-post-error')

      expect(conn.getStatusCode()).toBe(200)
      const events = conn.getReceivedEvents()
      expect(events.filter((e) => e.event === 'update')).toHaveLength(1)
      expect(events.some((e) => e.event === 'error')).toBe(false)
    })
  })

  describe('SSE event schema validation failure after start', () => {
    it('ends the stream silently: 200, zero events, no error event', async () => {
      const client = new SSEInjectClient(server.app)
      const conn = await client.connect('/api/error-test/sse-invalid-event')

      expect(conn.getStatusCode()).toBe(200)
      expect(conn.getReceivedEvents()).toHaveLength(0)
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
})
