import { createContainer } from 'awilix'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  buildContract,
  buildFastifyRoute,
  DIContext,
  SSEHttpClient,
  SSEInjectClient,
  SSETestServer,
} from '../../index.js'
import { defaultMethodContract } from './fixtures/testContracts.js'
import type {
  GenericDualModeController,
  TestChatDualModeController,
  TestJobStatusDualModeController,
} from './fixtures/testControllers.js'
import {
  GenericDualModeModule,
  TestAuthenticatedDualModeModule,
  TestChatDualModeModule,
  TestConversationDualModeModule,
  TestDefaultMethodDualModeModule,
  TestDefaultModeDualModeModule,
  TestErrorDualModeModule,
  TestJobStatusDualModeModule,
  TestJsonValidationDualModeModule,
} from './fixtures/testModules.js'

/**
 * Dual-Mode E2E Tests
 *
 * These tests verify that dual-mode controllers correctly:
 * 1. Branch based on Accept header
 * 2. Return JSON responses for Accept: application/json
 * 3. Stream SSE events for Accept: text/event-stream
 * 4. Handle path parameters with type-safe pathResolver
 * 5. Support authentication via preHandler
 * 6. Work with DI integration
 */

describe('Dual-Mode Accept Header Routing', () => {
  let server: SSETestServer<{ context: DIContext<object, object> }>
  let context: DIContext<object, object>
  let injectClient: SSEInjectClient

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestChatDualModeModule()] }, undefined)

    server = await SSETestServer.create(
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
    injectClient = new SSEInjectClient(server.app)
  })

  afterEach(async () => {
    await server.resources.context.destroy()
    await server.close()
  })

  it('returns JSON for Accept: application/json', { timeout: 10000 }, async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/chat/completions',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      payload: { message: 'Hello World' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('application/json')

    const body = JSON.parse(response.body)
    expect(body).toEqual({
      reply: 'Echo: Hello World',
      usage: { tokens: 2 },
    })
  })

  it('streams SSE for Accept: text/event-stream', { timeout: 10000 }, async () => {
    const conn = await injectClient.connectWithBody('/api/chat/completions', {
      message: 'Hello World',
    })

    expect(conn.getStatusCode()).toBe(200)
    expect(conn.getHeaders()['content-type']).toContain('text/event-stream')

    const events = conn.getReceivedEvents()
    const chunkEvents = events.filter((e) => e.event === 'chunk')
    const doneEvents = events.filter((e) => e.event === 'done')

    expect(chunkEvents).toHaveLength(2)
    expect(doneEvents).toHaveLength(1)

    expect(JSON.parse(chunkEvents[0]!.data)).toEqual({ delta: 'Hello' })
    expect(JSON.parse(chunkEvents[1]!.data)).toEqual({ delta: 'World' })
    expect(JSON.parse(doneEvents[0]!.data)).toEqual({ usage: { total: 2 } })
  })

  it('defaults to JSON when no Accept header', { timeout: 10000 }, async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/chat/completions',
      headers: {
        'content-type': 'application/json',
        // No Accept header
      },
      payload: { message: 'Test' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('application/json')
  })

  it('defaults to JSON for Accept: */*', { timeout: 10000 }, async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/chat/completions',
      headers: {
        'content-type': 'application/json',
        accept: '*/*',
      },
      payload: { message: 'Test' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('application/json')
  })

  it('respects quality values in Accept header', { timeout: 10000 }, async () => {
    // SSE has higher quality value
    const sseResponse = await injectClient.connectWithBody(
      '/api/chat/completions',
      { message: 'Test' },
      { headers: { accept: 'application/json;q=0.5, text/event-stream;q=1.0' } },
    )
    expect(sseResponse.getHeaders()['content-type']).toContain('text/event-stream')

    // JSON has higher quality value
    const jsonResponse = await server.app.inject({
      method: 'POST',
      url: '/api/chat/completions',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream;q=0.5, application/json;q=1.0',
      },
      payload: { message: 'Test' },
    })
    expect(jsonResponse.headers['content-type']).toContain('application/json')
  })

  it('falls back to default for unsupported Accept header', { timeout: 10000 }, async () => {
    // Accept: text/html is not supported, should fall back to JSON (default)
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/chat/completions',
      headers: {
        'content-type': 'application/json',
        accept: 'text/html',
      },
      payload: { message: 'Test' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('application/json')
  })
})

describe('Dual-Mode Path Parameters', () => {
  let server: SSETestServer<{ context: DIContext<object, object> }>
  let context: DIContext<object, object>
  let injectClient: SSEInjectClient

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestConversationDualModeModule()] }, undefined)

    server = await SSETestServer.create(
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
    injectClient = new SSEInjectClient(server.app)
  })

  afterEach(async () => {
    await server.resources.context.destroy()
    await server.close()
  })

  it('extracts path parameters correctly in JSON mode', { timeout: 10000 }, async () => {
    const conversationId = '550e8400-e29b-41d4-a716-446655440000'
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/completions`,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: 'Bearer test-token',
      },
      payload: { message: 'Hello' },
    })

    expect(response.statusCode).toBe(200)
    const body = JSON.parse(response.body)
    expect(body.conversationId).toBe(conversationId)
    expect(body.reply).toContain(conversationId)
  })

  it('extracts path parameters correctly in SSE mode', { timeout: 10000 }, async () => {
    const conversationId = '550e8400-e29b-41d4-a716-446655440000'
    const conn = await injectClient.connectWithBody(
      `/api/conversations/${conversationId}/completions`,
      { message: 'Hello World' },
      { headers: { authorization: 'Bearer test-token' } },
    )

    expect(conn.getStatusCode()).toBe(200)

    const events = conn.getReceivedEvents()
    const doneEvent = events.find((e) => e.event === 'done')

    expect(doneEvent).toBeDefined()
    expect(JSON.parse(doneEvent!.data).conversationId).toBe(conversationId)
  })
})

describe('Dual-Mode GET Routes', () => {
  let server: SSETestServer<{ context: DIContext<object, object> }>
  let context: DIContext<object, object>
  let controller: TestJobStatusDualModeController
  let injectClient: SSEInjectClient

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestJobStatusDualModeModule()] }, undefined)

    server = await SSETestServer.create(
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

    controller = context.diContainer.resolve('testJobStatusDualModeController')
    injectClient = new SSEInjectClient(server.app)
  })

  afterEach(async () => {
    await server.resources.context.destroy()
    await server.close()
  })

  it('handles GET dual-mode route in JSON mode', { timeout: 10000 }, async () => {
    const jobId = '550e8400-e29b-41d4-a716-446655440000'
    controller.setJobState(jobId, { status: 'completed', progress: 100, result: 'Success!' })

    const response = await server.app.inject({
      method: 'GET',
      url: `/api/jobs/${jobId}/status`,
      headers: {
        accept: 'application/json',
      },
    })

    expect(response.statusCode).toBe(200)
    const body = JSON.parse(response.body)
    expect(body.status).toBe('completed')
    expect(body.progress).toBe(100)
    expect(body.result).toBe('Success!')
  })

  it('handles GET dual-mode route in SSE mode', { timeout: 10000 }, async () => {
    const jobId = '550e8400-e29b-41d4-a716-446655440000'
    controller.setJobState(jobId, { status: 'completed', progress: 100, result: 'Done!' })

    const conn = await injectClient.connect(`/api/jobs/${jobId}/status`)

    expect(conn.getStatusCode()).toBe(200)

    const events = conn.getReceivedEvents()
    const progressEvents = events.filter((e) => e.event === 'progress')
    const doneEvents = events.filter((e) => e.event === 'done')

    expect(progressEvents.length).toBeGreaterThan(0)
    expect(doneEvents).toHaveLength(1)
    expect(JSON.parse(doneEvents[0]!.data).result).toBe('Done!')
  })
})

describe('Dual-Mode Authentication', () => {
  let server: SSETestServer<{ context: DIContext<object, object> }>
  let context: DIContext<object, object>
  let injectClient: SSEInjectClient

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestAuthenticatedDualModeModule()] }, undefined)

    server = await SSETestServer.create(
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
    injectClient = new SSEInjectClient(server.app)
  })

  afterEach(async () => {
    await server.resources.context.destroy()
    await server.close()
  })

  it('rejects unauthenticated JSON requests', { timeout: 10000 }, async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/protected/action',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      payload: { data: 'test' },
    })

    expect(response.statusCode).toBe(401)
  })

  it('accepts authenticated JSON requests', { timeout: 10000 }, async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/protected/action',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: 'Bearer valid-token',
      },
      payload: { data: 'test' },
    })

    expect(response.statusCode).toBe(200)
    const body = JSON.parse(response.body)
    expect(body.success).toBe(true)
  })

  it('rejects unauthenticated SSE requests', { timeout: 10000 }, async () => {
    const conn = await injectClient.connectWithBody('/api/protected/action', { data: 'test' })

    expect(conn.getStatusCode()).toBe(401)
  })

  it('accepts authenticated SSE requests', { timeout: 10000 }, async () => {
    const conn = await injectClient.connectWithBody(
      '/api/protected/action',
      { data: 'test' },
      { headers: { authorization: 'Bearer valid-token' } },
    )

    expect(conn.getStatusCode()).toBe(200)
    const events = conn.getReceivedEvents()
    expect(events).toHaveLength(1)
    expect(JSON.parse(events[0]!.data).success).toBe(true)
  })
})

describe('Dual-Mode Default Mode Override', () => {
  let server: SSETestServer<{ context: DIContext<object, object> }>
  let context: DIContext<object, object>

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestDefaultModeDualModeModule()] }, undefined)

    server = await SSETestServer.create(
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

  it('uses SSE as default when configured', { timeout: 10000 }, async () => {
    const injectClient = new SSEInjectClient(server.app)

    // No Accept header - should use SSE (the configured default)
    const conn = await injectClient.connectWithBody('/api/default-mode-test', { input: 'test' })

    expect(conn.getStatusCode()).toBe(200)
    expect(conn.getHeaders()['content-type']).toContain('text/event-stream')

    const events = conn.getReceivedEvents()
    expect(events).toHaveLength(1)
    expect(JSON.parse(events[0]!.data).value).toBe('SSE: test')
  })

  it('still respects explicit Accept: application/json', { timeout: 10000 }, async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/default-mode-test',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      payload: { input: 'test' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('application/json')
    expect(JSON.parse(response.body).output).toBe('JSON: test')
  })
})

describe('Dual-Mode SSE Error Handling', () => {
  let server: SSETestServer<{ context: DIContext<object, object> }>
  let context: DIContext<object, object>
  let injectClient: SSEInjectClient

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestErrorDualModeModule()] }, undefined)

    server = await SSETestServer.create(
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
    injectClient = new SSEInjectClient(server.app)
  })

  afterEach(async () => {
    await server.resources.context.destroy()
    await server.close()
  })

  it('sends error event when SSE handler throws', { timeout: 10000 }, async () => {
    const conn = await injectClient.connectWithBody('/api/error-test', { shouldThrow: true })

    // Should still get 200 since headers are sent before error
    expect(conn.getStatusCode()).toBe(200)

    const events = conn.getReceivedEvents()
    const errorEvent = events.find((e) => e.event === 'error')

    expect(errorEvent).toBeDefined()
    expect(JSON.parse(errorEvent!.data).message).toBe('Test error in SSE handler')
  })

  it('works normally when no error', { timeout: 10000 }, async () => {
    const conn = await injectClient.connectWithBody('/api/error-test', { shouldThrow: false })

    expect(conn.getStatusCode()).toBe(200)

    const events = conn.getReceivedEvents()
    const resultEvent = events.find((e) => e.event === 'result')

    expect(resultEvent).toBeDefined()
    expect(JSON.parse(resultEvent!.data).success).toBe(true)
  })
})

describe('Dual-Mode Real HTTP Client', () => {
  let server: SSETestServer<{ context: DIContext<object, object> }>
  let context: DIContext<object, object>
  let controller: TestJobStatusDualModeController

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestJobStatusDualModeModule()] }, undefined)

    server = await SSETestServer.create(
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

    controller = context.diContainer.resolve('testJobStatusDualModeController')
  })

  afterEach(async () => {
    await server.resources.context.destroy()
    await server.close()
  })

  it('works with SSEHttpClient for GET dual-mode SSE', { timeout: 10000 }, async () => {
    const jobId = '550e8400-e29b-41d4-a716-446655440000'
    controller.setJobState(jobId, { status: 'completed', progress: 100, result: 'Done!' })

    // Connect without awaitServerConnection since the handler closes immediately
    const client = await SSEHttpClient.connect(server.baseUrl, `/api/jobs/${jobId}/status`)

    expect(client.response.ok).toBe(true)
    expect(client.response.headers.get('content-type')).toContain('text/event-stream')

    // Collect events until done (progress events + done event)
    const events = await client.collectEvents((e) => e.event === 'done', 5000)

    expect(events.length).toBeGreaterThan(0)
    const progressEvents = events.filter((e) => e.event === 'progress')
    const doneEvents = events.filter((e) => e.event === 'done')
    expect(progressEvents.length).toBeGreaterThan(0)
    expect(doneEvents).toHaveLength(1)
    expect(JSON.parse(doneEvents[0]!.data).result).toBe('Done!')

    client.close()
  })
})

describe('Dual-Mode Default Method', () => {
  let server: SSETestServer<{ context: DIContext<object, object> }>
  let context: DIContext<object, object>

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestDefaultMethodDualModeModule()] }, undefined)

    server = await SSETestServer.create(
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

  it('uses POST as default when method is not specified', { timeout: 10000 }, async () => {
    // Verify the contract has POST method (default)
    expect(defaultMethodContract.method).toBe('POST')

    // Test the endpoint works with POST
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/default-method-test',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      payload: { value: 'test-value' },
    })

    expect(response.statusCode).toBe(200)
    const body = JSON.parse(response.body)
    expect(body.result).toBe('Processed: test-value')
  })

  it('rejects GET on POST-defaulted endpoint', { timeout: 10000 }, async () => {
    const response = await server.app.inject({
      method: 'GET',
      url: '/api/default-method-test',
      headers: {
        accept: 'application/json',
      },
    })

    // Should return 404 since GET is not registered
    expect(response.statusCode).toBe(404)
  })
})

describe('Dual-Mode JSON Response Validation', () => {
  let server: SSETestServer<{ context: DIContext<object, object> }>
  let context: DIContext<object, object>

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestJsonValidationDualModeModule()] }, undefined)

    server = await SSETestServer.create(
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

  it('returns 500 when JSON response validation fails', { timeout: 10000 }, async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/json-validation-test',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      payload: { returnInvalid: true },
    })

    // Should return 500 with error about validation failure
    expect(response.statusCode).toBe(500)
    const body = JSON.parse(response.body)
    expect(body.message).toContain('Response validation failed for application/json')
  })

  it('returns 200 when JSON response is valid', { timeout: 10000 }, async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/json-validation-test',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      payload: { returnInvalid: false },
    })

    expect(response.statusCode).toBe(200)
    const body = JSON.parse(response.body)
    expect(body.requiredField).toBe('valid')
    expect(body.count).toBe(42)
  })
})

describe('Dual-Mode Controller Methods', () => {
  it('buildSSERoutes returns empty object', async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    const context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestChatDualModeModule()] }, undefined)

    const controller: TestChatDualModeController = context.diContainer.resolve(
      'testChatDualModeController',
    )

    // buildSSERoutes should return empty object for dual-mode controllers
    const sseRoutes = controller.buildSSERoutes()
    expect(sseRoutes).toEqual({})

    await context.destroy()
  })

  it('sendDualModeEventInternal sends event to connection', { timeout: 10000 }, async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    const context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestChatDualModeModule()] }, undefined)

    const server = await SSETestServer.create(
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

    const controller: TestChatDualModeController = context.diContainer.resolve(
      'testChatDualModeController',
    )

    const injectClient = new SSEInjectClient(server.app)

    // Start an SSE connection (don't await yet - connection closes quickly)
    const connectionPromise = injectClient.connectWithBody('/api/chat/completions', {
      message: 'test',
    })

    // Wait for connection using connectionSpy
    const connection = await controller.connectionSpy.waitForConnection({ timeout: 2000 })

    // Use sendDualModeEventInternal to send a typed event
    const result = await controller.sendDualModeEventInternal(connection.id, {
      event: 'chunk',
      data: { delta: 'extra-chunk' },
    })

    expect(result).toBe(true)

    // Clean up
    const conn = await connectionPromise
    expect(conn.getStatusCode()).toBe(200)

    // Verify the extra event was received
    const events = conn.getReceivedEvents()
    const extraChunk = events.find(
      (e) => e.event === 'chunk' && e.data === JSON.stringify({ delta: 'extra-chunk' }),
    )
    expect(extraChunk).toBeDefined()

    await server.resources.context.destroy()
    await server.close()
  })

  it('sendDualModeEventInternal returns false for non-existent connection', async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    const context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestChatDualModeModule()] }, undefined)

    const controller: TestChatDualModeController = context.diContainer.resolve(
      'testChatDualModeController',
    )

    // Try to send to a non-existent connection
    const result = await controller.sendDualModeEventInternal('non-existent-id', {
      event: 'chunk',
      data: { delta: 'test' },
    })

    expect(result).toBe(false)

    await context.destroy()
  })
})

describe('Dual-Mode DI Integration', () => {
  it('hasDualModeControllers returns true when controllers registered', async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    const context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestChatDualModeModule()] }, undefined)

    expect(context.hasDualModeControllers()).toBe(true)

    await context.destroy()
  })

  it('hasDualModeControllers returns false when no controllers', async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    const context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [] }, undefined)

    expect(context.hasDualModeControllers()).toBe(false)

    await context.destroy()
  })

  it('connectionSpy works in test mode', async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    const context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestChatDualModeModule()] }, undefined)

    const controller: TestChatDualModeController = context.diContainer.resolve(
      'testChatDualModeController',
    )

    // connectionSpy should be available
    expect(() => controller.connectionSpy).not.toThrow()

    await context.destroy()
  })

  it('connectionSpy throws when not in test mode', async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    const context = new DIContext<object, object>(container, { isTestMode: false }, {})
    context.registerDependencies({ modules: [new TestChatDualModeModule()] }, undefined)

    const controller: TestChatDualModeController = context.diContainer.resolve(
      'testChatDualModeController',
    )

    // connectionSpy should throw
    expect(() => controller.connectionSpy).toThrow('Connection spy is not enabled')

    await context.destroy()
  })
})

describe('Dual-Mode Route Builder Validation', () => {
  it('throws error when params is not a ZodObject', async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    const context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new GenericDualModeModule()] }, undefined)

    const controller: GenericDualModeController = context.diContainer.resolve(
      'genericDualModeController',
    )

    // Create an invalid contract where params is a ZodString instead of ZodObject
    const invalidContract = {
      method: 'POST' as const,
      pathResolver: () => '/api/invalid',
      params: z.string(), // Invalid: should be ZodObject
      query: z.object({}),
      requestHeaders: z.object({}),
      requestBody: z.object({ data: z.string() }),
      jsonResponse: z.object({ result: z.string() }),
      events: { result: z.object({ success: z.boolean() }) },
      isDualMode: true as const,
      isSimplified: true as const,
    }

    expect(() =>
      buildFastifyRoute(controller, {
        contract: invalidContract,
        handlers: {
          json: async () => ({ result: 'test' }),
          sse: (_request, sse) => {
            sse.start('autoClose')
          },
        },
      }),
    ).toThrow('Route params schema must be a ZodObject for path template extraction')

    await context.destroy()
  })
})

describe('Dual-Mode Response Headers', () => {
  it('validates response headers when schema is defined', async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    const context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new GenericDualModeModule()] }, undefined)

    const controller: GenericDualModeController = context.diContainer.resolve(
      'genericDualModeController',
    )

    // Create a contract with responseHeaders schema
    const contractWithHeaders = buildContract({
      method: 'POST',
      pathResolver: () => '/api/with-headers',
      params: z.object({}),
      query: z.object({}),
      requestHeaders: z.object({}),
      requestBody: z.object({ data: z.string() }),
      jsonResponse: z.object({ result: z.string() }),
      responseHeaders: z.object({
        'x-request-id': z.string(),
        'x-ratelimit-remaining': z.string(),
      }),
      events: { result: z.object({ success: z.boolean() }) },
    })

    const route = buildFastifyRoute(controller, {
      contract: contractWithHeaders,
      handlers: {
        json: (request, reply) => {
          // Set the required headers
          reply.header('x-request-id', 'req-123')
          reply.header('x-ratelimit-remaining', '99')
          return { result: request.body.data }
        },
        sse: (_request, sse) => {
          sse.start('autoClose')
        },
      },
    })

    const server = await SSETestServer.create(
      (app) => {
        app.route(route)
      },
      {
        configureApp: (app) => {
          app.setValidatorCompiler(validatorCompiler)
          app.setSerializerCompiler(serializerCompiler)
        },
        setup: () => ({ context }),
      },
    )

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/with-headers',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      payload: { data: 'test' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['x-request-id']).toBe('req-123')
    expect(response.headers['x-ratelimit-remaining']).toBe('99')
    expect(response.json()).toEqual({ result: 'test' })

    await context.destroy()
    await server.close()
  })

  it('throws validation error when required response headers are missing', async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    const context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new GenericDualModeModule()] }, undefined)

    const controller: GenericDualModeController = context.diContainer.resolve(
      'genericDualModeController',
    )

    // Create a contract with responseHeaders schema
    const contractWithHeaders = buildContract({
      method: 'POST',
      pathResolver: () => '/api/missing-headers',
      params: z.object({}),
      query: z.object({}),
      requestHeaders: z.object({}),
      requestBody: z.object({ data: z.string() }),
      jsonResponse: z.object({ result: z.string() }),
      responseHeaders: z.object({
        'x-required-header': z.string(),
      }),
      events: { result: z.object({ success: z.boolean() }) },
    })

    const route = buildFastifyRoute(controller, {
      contract: contractWithHeaders,
      handlers: {
        json: (request) => {
          // Intentionally NOT setting the required header
          return { result: request.body.data }
        },
        sse: (_request, sse) => {
          sse.start('autoClose')
        },
      },
    })

    const server = await SSETestServer.create(
      (app) => {
        app.route(route)
      },
      {
        configureApp: (app) => {
          app.setValidatorCompiler(validatorCompiler)
          app.setSerializerCompiler(serializerCompiler)
        },
        setup: () => ({ context }),
      },
    )

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/missing-headers',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      payload: { data: 'test' },
    })

    // Should fail validation
    expect(response.statusCode).toBe(500)
    expect(response.json().message).toContain('Response headers validation failed')

    await context.destroy()
    await server.close()
  })

  it('works without responseHeaders schema (optional)', async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    const context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new GenericDualModeModule()] }, undefined)

    const controller: GenericDualModeController = context.diContainer.resolve(
      'genericDualModeController',
    )

    // Create a contract WITHOUT responseHeaders schema
    const contractWithoutHeaders = buildContract({
      method: 'POST',
      pathResolver: () => '/api/no-headers',
      params: z.object({}),
      query: z.object({}),
      requestHeaders: z.object({}),
      requestBody: z.object({ data: z.string() }),
      jsonResponse: z.object({ result: z.string() }),
      // No responseHeaders - should still work
      events: { result: z.object({ success: z.boolean() }) },
    })

    const route = buildFastifyRoute(controller, {
      contract: contractWithoutHeaders,
      handlers: {
        json: (request) => {
          return { result: request.body.data }
        },
        sse: (_request, sse) => {
          sse.start('autoClose')
        },
      },
    })

    const server = await SSETestServer.create(
      (app) => {
        app.route(route)
      },
      {
        configureApp: (app) => {
          app.setValidatorCompiler(validatorCompiler)
          app.setSerializerCompiler(serializerCompiler)
        },
        setup: () => ({ context }),
      },
    )

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/no-headers',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      payload: { data: 'test' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ result: 'test' })

    await context.destroy()
    await server.close()
  })
})
