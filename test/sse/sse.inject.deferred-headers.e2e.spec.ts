import { createContainer } from 'awilix'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildFastifyRoute,
  DIContext,
  injectPayloadSSE,
  injectSSE,
  parseSSEEvents,
  SSETestServer,
} from '../../index.js'
import {
  deferredHeaders404Contract,
  deferredHeaders422Contract,
  errorAfterStartContract,
  forgottenStartContract,
} from './fixtures/testContracts.js'
import type {
  TestDeferredHeaders404Controller,
  TestDeferredHeaders422Controller,
  TestErrorAfterStartController,
  TestForgottenStartController,
} from './fixtures/testControllers.js'
import {
  TestDeferredHeaders404Module,
  TestDeferredHeaders422Module,
  TestErrorAfterStartModule,
  TestForgottenStartModule,
} from './fixtures/testModules.js'

// ============================================================================
// SSE Deferred Headers Tests
// ============================================================================

/**
 * Tests for SSE Deferred Headers feature.
 *
 * The key capability: handlers can perform validation BEFORE HTTP headers are sent,
 * enabling proper HTTP responses (404, 422, etc.) for early returns instead of
 * always returning 200 and then sending an SSE error event.
 *
 * API pattern:
 * 1. Handler receives `sse` context (not session)
 * 2. Handler performs validation
 * 3. If validation fails: `return sse.respond(code, body)` - sends HTTP response
 * 4. If validation passes: `const session = sse.start('autoClose'|'keepAlive')` - sends 200 + SSE headers
 * 5. Stream events via `session.send()`
 * 6. Handler returns (session mode determines lifecycle: autoClose closes, keepAlive stays open)
 */
describe('SSE Inject E2E (deferred headers - HTTP error before streaming)', () => {
  let server: SSETestServer<{ context: DIContext<object, object> }>
  let context: DIContext<object, object>

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestDeferredHeaders404Module()] }, undefined)

    const controller = context.diContainer.resolve<TestDeferredHeaders404Controller>(
      'testDeferredHeaders404Controller',
    )

    server = await SSETestServer.create(
      (app) => {
        app.route(buildFastifyRoute(controller, controller.buildSSERoutes().deferred404))
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
    await context.destroy()
    await server.close()
  })

  it(
    'returns HTTP 404 when entity not found, before streaming starts',
    { timeout: 10000 },
    async () => {
      // Test: request for non-existent entity
      const { closed } = injectSSE(server.app, deferredHeaders404Contract, {
        params: { id: 'not-found' },
      })

      const response = await closed

      // Should return proper HTTP 404, not 200 with SSE error event
      expect(response.statusCode).toBe(404)
      expect(response.headers['content-type']).toContain('application/json')

      // Response body should be our error object (use JSON.parse since error responses aren't SSE)
      const body = JSON.parse(response.body)
      expect(body).toEqual({ error: 'Entity not found', id: 'not-found' })

      // Should NOT have SSE content-type (cache-control may be present due to @fastify/sse internals)
      expect(response.headers['content-type']).not.toContain('text/event-stream')
    },
  )

  it('returns HTTP 200 with SSE when entity exists', { timeout: 10000 }, async () => {
    // Test: request for existing entity (controller has 'existing-123' and 'another-456' pre-added)
    const { closed } = injectSSE(server.app, deferredHeaders404Contract, {
      params: { id: 'existing-123' },
    })

    const response = await closed

    // Should return 200 with SSE
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/event-stream')

    const events = parseSSEEvents(response.body)
    expect(events).toHaveLength(1)
    expect(events[0]!.event).toBe('message')
    expect(JSON.parse(events[0]!.data)).toEqual({ text: 'Found entity existing-123' })
  })
})

describe('SSE Inject E2E (deferred headers - 422 validation)', () => {
  let server: SSETestServer<{ context: DIContext<object, object> }>
  let context: DIContext<object, object>

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestDeferredHeaders422Module()] }, undefined)

    const controller = context.diContainer.resolve<TestDeferredHeaders422Controller>(
      'testDeferredHeaders422Controller',
    )

    server = await SSETestServer.create(
      (app) => {
        app.route(buildFastifyRoute(controller, controller.buildSSERoutes().validate))
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
    await context.destroy()
    await server.close()
  })

  it('returns HTTP 422 for negative value', { timeout: 10000 }, async () => {
    const { closed } = injectPayloadSSE(server.app, deferredHeaders422Contract, {
      body: { value: -5 },
    })

    const response = await closed
    expect(response.statusCode).toBe(422)
    // Use JSON.parse since error responses aren't SSE
    expect(JSON.parse(response.body)).toEqual({
      error: 'Validation failed',
      details: 'Value must be non-negative',
      received: -5,
    })
  })

  it('returns HTTP 422 for value too large', { timeout: 10000 }, async () => {
    const { closed } = injectPayloadSSE(server.app, deferredHeaders422Contract, {
      body: { value: 9999 },
    })

    const response = await closed
    expect(response.statusCode).toBe(422)
    // Use JSON.parse since error responses aren't SSE
    expect(JSON.parse(response.body)).toEqual({
      error: 'Validation failed',
      details: 'Value must be at most 1000',
      received: 9999,
    })
  })

  it('returns HTTP 200 with SSE for valid value', { timeout: 10000 }, async () => {
    const { closed } = injectPayloadSSE(server.app, deferredHeaders422Contract, {
      body: { value: 50 },
    })

    const response = await closed
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/event-stream')

    const events = parseSSEEvents(response.body)
    expect(events).toHaveLength(1)
    expect(JSON.parse(events[0]!.data)).toEqual({ computed: 100 })
  })
})

describe('SSE Inject E2E (deferred headers - error detection)', () => {
  it(
    'throws error when handler forgets to call start() or error()',
    { timeout: 10000 },
    async () => {
      const container = createContainer({ injectionMode: 'PROXY' })
      const context = new DIContext<object, object>(container, { isTestMode: true }, {})
      context.registerDependencies({ modules: [new TestForgottenStartModule()] }, undefined)

      const controller = context.diContainer.resolve<TestForgottenStartController>(
        'testForgottenStartController',
      )

      const server = await SSETestServer.create(
        (app) => {
          app.route(buildFastifyRoute(controller, controller.buildSSERoutes().forgottenStart))
        },
        {
          configureApp: (app) => {
            app.setValidatorCompiler(validatorCompiler)
            app.setSerializerCompiler(serializerCompiler)
          },
          setup: () => ({ context }),
        },
      )

      // This should result in an error because handler didn't call start() or error()
      const { closed } = injectSSE(server.app, forgottenStartContract, {})

      const response = await closed

      // The framework should detect the bug and return an internal server error
      expect(response.statusCode).toBe(500)
      // Use JSON.parse since error responses aren't SSE
      const body = JSON.parse(response.body)
      expect(body.message).toContain('SSE handler must')

      await context.destroy()
      await server.close()
    },
  )

  it('sends SSE error event when error thrown after start()', { timeout: 10000 }, async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    const context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestErrorAfterStartModule()] }, undefined)

    const controller = context.diContainer.resolve<TestErrorAfterStartController>(
      'testErrorAfterStartController',
    )

    const server = await SSETestServer.create(
      (app) => {
        app.route(buildFastifyRoute(controller, controller.buildSSERoutes().errorAfterStart))
      },
      {
        configureApp: (app) => {
          app.setValidatorCompiler(validatorCompiler)
          app.setSerializerCompiler(serializerCompiler)
        },
        setup: () => ({ context }),
      },
    )

    const { closed } = injectSSE(server.app, errorAfterStartContract, {})

    const response = await closed

    // Should still return 200 because headers were already sent
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/event-stream')

    const events = parseSSEEvents(response.body)

    // Should have the first message event
    const messageEvent = events.find((e) => e.event === 'message')
    expect(messageEvent).toBeDefined()
    expect(JSON.parse(messageEvent!.data)).toEqual({ text: 'First message' })

    // Should have an SSE error event
    const errorEvent = events.find((e) => e.event === 'error')
    expect(errorEvent).toBeDefined()
    const errorData = JSON.parse(errorEvent!.data)
    expect(errorData.message).toContain('Simulated error after streaming started')

    await context.destroy()
    await server.close()
  })
})
