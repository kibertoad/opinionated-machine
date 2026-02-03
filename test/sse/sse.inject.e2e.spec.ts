import { createContainer } from 'awilix'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildFastifyRoute,
  DIContext,
  injectPayloadSSE,
  injectSSE,
  parseSSEEvents,
  SSEInjectConnection,
  type SSELogger,
  SSETestServer,
} from '../../index.js'
import {
  asyncReconnectStreamContract,
  authenticatedStreamContract,
  channelStreamContract,
  chatCompletionContract,
  deferredHeaders404Contract,
  deferredHeaders422Contract,
  errorAfterStartContract,
  forgottenStartContract,
  getStreamTestContract,
  isConnectedTestStreamContract,
  largeContentStreamContract,
  onCloseErrorStreamContract,
  openaiStyleStreamContract,
  reconnectStreamContract,
  sendStreamTestContract,
} from './fixtures/testContracts.js'
import type {
  TestDeferredHeaders404Controller,
  TestDeferredHeaders422Controller,
  TestErrorAfterStartController,
  TestForgottenStartController,
  TestOnCloseErrorSSEController,
  TestSSEController,
} from './fixtures/testControllers.js'
import {
  TestAuthSSEModule,
  TestChannelSSEModule,
  TestDeferredHeaders404Module,
  TestDeferredHeaders422Module,
  TestErrorAfterStartModule,
  TestForgottenStartModule,
  TestGetStreamSSEModule,
  TestIsConnectedSSEModule,
  TestOnCloseErrorSSEModule,
  type TestOnCloseErrorSSEModuleDependencies,
  TestOpenAIStyleSSEModule,
  TestPostSSEModule,
  TestReconnectSSEModule,
  type TestReconnectSSEModuleDependencies,
  TestSendStreamSSEModule,
  TestSSEModule,
  type TestSSEModuleDependencies,
} from './fixtures/testModules.js'

/**
 * SSE E2E tests using Fastify inject helpers (injectSSE, injectPayloadSSE).
 *
 * These tests use Fastify's built-in inject() for in-memory testing, suitable for:
 * - Request-response style SSE (OpenAI completions, batch exports)
 * - Fast unit-style testing without network overhead
 * - Tests where the handler closes the connection after sending events
 *
 * Note: Handler must close the connection for inject to complete.
 */

describe('SSE Inject E2E (OpenAI-style streaming)', () => {
  let server: SSETestServer<{ context: DIContext<object, object> }>
  let context: DIContext<object, object>

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestPostSSEModule()] }, undefined)

    server = await SSETestServer.create(
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

  it('streams response chunks for POST request', { timeout: 10000 }, async () => {
    const { closed } = injectPayloadSSE(server.app, chatCompletionContract, {
      body: { message: 'Hello World', stream: true as const },
    })

    const response = await closed

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/event-stream')

    const events = parseSSEEvents(response.body)

    // Should have chunk events for each word plus a done event
    const chunkEvents = events.filter((e) => e.event === 'chunk')
    const doneEvents = events.filter((e) => e.event === 'done')

    expect(chunkEvents).toHaveLength(2) // "Hello" and "World"
    expect(doneEvents).toHaveLength(1)

    expect(JSON.parse(chunkEvents[0]!.data)).toEqual({ content: 'Hello' })
    expect(JSON.parse(chunkEvents[1]!.data)).toEqual({ content: 'World' })
    expect(JSON.parse(doneEvents[0]!.data)).toEqual({ totalTokens: 2 })
  })

  it('handles longer streaming responses', { timeout: 10000 }, async () => {
    const longMessage = 'The quick brown fox jumps over the lazy dog'
    const words = longMessage.split(' ')

    const { closed } = injectPayloadSSE(server.app, chatCompletionContract, {
      body: { message: longMessage, stream: true as const },
    })

    const response = await closed
    const events = parseSSEEvents(response.body)

    const chunkEvents = events.filter((e) => e.event === 'chunk')
    expect(chunkEvents).toHaveLength(words.length)

    // Verify all words streamed in order
    for (let i = 0; i < words.length; i++) {
      expect(JSON.parse(chunkEvents[i]!.data).content).toBe(words[i])
    }

    // Done event should have correct token count
    const doneEvent = events.find((e) => e.event === 'done')!
    expect(JSON.parse(doneEvent.data).totalTokens).toBe(words.length)
  })

  it('returns proper SSE headers for POST requests', { timeout: 10000 }, async () => {
    const { closed } = injectPayloadSSE(server.app, chatCompletionContract, {
      body: { message: 'test', stream: true as const },
    })

    const response = await closed

    expect(response.headers['content-type']).toContain('text/event-stream')
    expect(response.headers['cache-control']).toContain('no-cache')
  })

  it(
    'streams large content without data loss from closeConnection',
    { timeout: 10000 },
    async () => {
      // Test with many chunks of significant size to verify closeConnection
      // doesn't cut off data transfer prematurely
      // 10MB total: 1000 chunks × 10KB each
      const chunkCount = 1000
      const chunkSize = 10000
      const expectedTotalBytes = chunkCount * chunkSize

      const { closed } = injectPayloadSSE(server.app, largeContentStreamContract, {
        body: { chunkCount, chunkSize },
      })

      const response = await closed

      expect(response.statusCode).toBe(200)

      // Verify response body is substantial
      expect(response.body.length).toBeGreaterThan(expectedTotalBytes)

      const events = parseSSEEvents(response.body)
      const chunkEvents = events.filter((e) => e.event === 'chunk')
      const doneEvents = events.filter((e) => e.event === 'done')

      // Verify all chunks were received
      expect(chunkEvents).toHaveLength(chunkCount)
      expect(doneEvents).toHaveLength(1)

      // Verify first, middle, and last chunks for order and content integrity
      const checkIndices = [0, Math.floor(chunkCount / 2), chunkCount - 1]
      for (const i of checkIndices) {
        const data = JSON.parse(chunkEvents[i]!.data)
        expect(data.index).toBe(i)
        expect(data.content.length).toBe(chunkSize)
        expect(data.content).toContain(`[chunk-${i}]`)
      }

      // Verify done event totals
      const doneData = JSON.parse(doneEvents[0]!.data)
      expect(doneData.totalChunks).toBe(chunkCount)
      expect(doneData.totalBytes).toBe(expectedTotalBytes)
    },
  )

  it('handles very large individual chunks', { timeout: 10000 }, async () => {
    // Test with fewer but larger chunks (10 x 10KB = 100KB)
    const chunkCount = 10
    const chunkSize = 10000

    const { closed } = injectPayloadSSE(server.app, largeContentStreamContract, {
      body: { chunkCount, chunkSize },
    })

    const response = await closed

    expect(response.statusCode).toBe(200)

    const events = parseSSEEvents(response.body)
    const chunkEvents = events.filter((e) => e.event === 'chunk')

    expect(chunkEvents).toHaveLength(chunkCount)

    // Verify each large chunk is complete
    for (const event of chunkEvents) {
      const data = JSON.parse(event.data)
      expect(data.content.length).toBe(chunkSize)
    }
  })
})

describe('SSE Inject E2E (authentication)', () => {
  let server: SSETestServer<{ context: DIContext<object, object> }>
  let context: DIContext<object, object>

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestAuthSSEModule()] }, undefined)

    server = await SSETestServer.create(
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

  it('rejects requests without authorization header', { timeout: 10000 }, async () => {
    const { closed } = injectSSE(server.app, authenticatedStreamContract, {
      headers: { authorization: '' },
    })

    const response = await closed

    expect(response.statusCode).toBe(401)
  })

  it('rejects requests with invalid authorization format', { timeout: 10000 }, async () => {
    const { closed } = injectSSE(server.app, authenticatedStreamContract, {
      headers: { authorization: 'Basic invalid' },
    })

    const response = await closed

    expect(response.statusCode).toBe(401)
  })

  it('accepts requests with valid Bearer token', { timeout: 10000 }, async () => {
    const { closed } = injectSSE(server.app, authenticatedStreamContract, {
      headers: { authorization: 'Bearer valid-token' },
    })

    const response = await closed

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/event-stream')

    const events = parseSSEEvents(response.body)
    expect(events).toHaveLength(1)
    expect(events[0]!.event).toBe('data')
    expect(JSON.parse(events[0]!.data)).toEqual({ value: 'authenticated data' })
  })
})

describe('SSE Inject E2E (path parameters)', () => {
  let server: SSETestServer<{ context: DIContext<object, object> }>
  let context: DIContext<object, object>

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestChannelSSEModule()] }, undefined)

    server = await SSETestServer.create(
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

  it('handles path parameters correctly', { timeout: 10000 }, async () => {
    const { closed } = injectSSE(server.app, channelStreamContract, {
      params: { channelId: 'general' },
    })

    const response = await closed

    expect(response.statusCode).toBe(200)

    const events = parseSSEEvents(response.body)
    expect(events).toHaveLength(1)
    expect(events[0]!.event).toBe('message')
    expect(JSON.parse(events[0]!.data)).toEqual({
      id: '1',
      content: 'Welcome to channel general',
      author: 'system',
    })
  })

  it('handles different channel IDs', { timeout: 10000 }, async () => {
    const channelIds = ['channel-1', 'lobby', 'support-123']

    for (const channelId of channelIds) {
      const { closed } = injectSSE(server.app, channelStreamContract, {
        params: { channelId },
      })

      const response = await closed
      const events = parseSSEEvents(response.body)

      expect(JSON.parse(events[0]!.data).content).toBe(`Welcome to channel ${channelId}`)
    }
  })

  it('handles path params with query params together', { timeout: 10000 }, async () => {
    const { closed } = injectSSE(server.app, channelStreamContract, {
      params: { channelId: 'test-channel' },
      query: { since: '2024-01-01' },
    })

    const response = await closed

    expect(response.statusCode).toBe(200)

    const events = parseSSEEvents(response.body)
    expect(events).toHaveLength(1)
    expect(JSON.parse(events[0]!.data).content).toBe('Welcome to channel test-channel')
  })

  it('filters out undefined and null query params', { timeout: 10000 }, async () => {
    // Query params with undefined/null values should be filtered out
    const { closed } = injectSSE(server.app, channelStreamContract, {
      params: { channelId: 'filter-test' },
      query: { since: undefined, other: null } as Record<string, unknown>,
    })

    const response = await closed

    expect(response.statusCode).toBe(200)

    const events = parseSSEEvents(response.body)
    expect(events).toHaveLength(1)
    expect(JSON.parse(events[0]!.data).content).toBe('Welcome to channel filter-test')
  })
})

/**
 * Tests for SSE Last-Event-ID reconnection mechanism.
 *
 * How SSE reconnection works:
 * 1. Client connects and receives events, each with an `id` field
 * 2. Client disconnects (network error, server restart, etc.)
 * 3. Browser automatically reconnects and sends `Last-Event-ID` header with the last received event ID
 * 4. Server's `onReconnect` handler receives this ID and replays missed events
 *
 * These tests simulate step 3 by sending the `Last-Event-ID` header directly.
 * The server doesn't track previous sessions - it just responds to the header.
 */
describe('SSE Inject E2E (Last-Event-ID reconnection)', () => {
  let server: SSETestServer<{ context: DIContext<TestReconnectSSEModuleDependencies, object> }>
  let context: DIContext<TestReconnectSSEModuleDependencies, object>

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<TestReconnectSSEModuleDependencies, object>(
      container,
      { isTestMode: true },
      {},
    )
    context.registerDependencies({ modules: [new TestReconnectSSEModule()] }, undefined)

    server = await SSETestServer.create(
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

  it('replays events after Last-Event-ID on reconnection', { timeout: 10000 }, async () => {
    // Use injectSSE with Last-Event-ID header to simulate reconnection
    const { closed } = injectSSE(server.app, reconnectStreamContract, {
      headers: { 'last-event-id': '2' } as Record<string, string>,
    })

    const response = await closed

    expect(response.statusCode).toBe(200)

    const events = parseSSEEvents(response.body)
    // Should replay events 3, 4, 5 (after id 2) plus the new event 6
    const eventDatas = events.map((e) => JSON.parse(e.data))

    // Events 3, 4, 5 are replayed, then 6 is sent by the handler
    expect(eventDatas).toContainEqual({ id: '3', data: 'Third event' })
    expect(eventDatas).toContainEqual({ id: '4', data: 'Fourth event' })
    expect(eventDatas).toContainEqual({ id: '5', data: 'Fifth event' })
    expect(eventDatas).toContainEqual({ id: '6', data: 'New event after reconnect' })
  })

  it('sends only new events when reconnecting with latest ID', { timeout: 10000 }, async () => {
    const { closed } = injectSSE(server.app, reconnectStreamContract, {
      headers: { 'last-event-id': '5' } as Record<string, string>,
    })

    const response = await closed

    expect(response.statusCode).toBe(200)

    const events = parseSSEEvents(response.body)
    // No events to replay after id 5, just the new event 6
    expect(events).toHaveLength(1)
    expect(JSON.parse(events[0]!.data)).toEqual({ id: '6', data: 'New event after reconnect' })
  })

  it('connects without replay when no Last-Event-ID', { timeout: 10000 }, async () => {
    const { closed } = injectSSE(server.app, reconnectStreamContract, {})

    const response = await closed

    expect(response.statusCode).toBe(200)

    const events = parseSSEEvents(response.body)
    // Just the new event, no replay
    expect(events).toHaveLength(1)
    expect(JSON.parse(events[0]!.data)).toEqual({ id: '6', data: 'New event after reconnect' })
  })

  it('replays events using async iterable', { timeout: 10000 }, async () => {
    const { closed } = injectSSE(server.app, asyncReconnectStreamContract, {
      headers: { 'last-event-id': '1' },
    })

    const response = await closed

    expect(response.statusCode).toBe(200)

    const events = parseSSEEvents(response.body)
    const eventDatas = events.map((e) => JSON.parse(e.data))

    // Events 2, 3 are replayed via async generator, then 4 is sent by handler
    expect(eventDatas).toContainEqual({ id: '2', data: 'Async second event' })
    expect(eventDatas).toContainEqual({ id: '3', data: 'Async third event' })
    expect(eventDatas).toContainEqual({ id: '4', data: 'Async new event after reconnect' })
  })

  it('async replay works with no events to replay', { timeout: 10000 }, async () => {
    const { closed } = injectSSE(server.app, asyncReconnectStreamContract, {
      headers: { 'last-event-id': '3' },
    })

    const response = await closed

    expect(response.statusCode).toBe(200)

    const events = parseSSEEvents(response.body)
    // No events to replay after id 3, just the new event 4
    expect(events).toHaveLength(1)
    expect(JSON.parse(events[0]!.data)).toEqual({
      id: '4',
      data: 'Async new event after reconnect',
    })
  })
})

describe('SSE Inject E2E (controller without spy)', () => {
  it('throws error when accessing connectionSpy without enableConnectionSpy', async () => {
    // Create a controller without spy enabled (isTestMode: false)
    const container = createContainer({ injectionMode: 'PROXY' })
    const context = new DIContext<TestSSEModuleDependencies, object>(
      container,
      { isTestMode: false }, // Spy not enabled
      {},
    )
    context.registerDependencies({ modules: [new TestSSEModule()] }, undefined)

    const controller = context.diContainer.resolve<TestSSEController>('testSSEController')

    expect(() => controller.connectionSpy).toThrow(
      'Connection spy is not enabled. Pass { enableConnectionSpy: true } to the constructor.',
    )

    await context.destroy()
  })
})

/**
 * Tests for OpenAI-style streaming with string terminator.
 *
 * OpenAI's streaming API uses a specific pattern:
 * 1. JSON chunks are streamed with content deltas
 * 2. The stream ends with a simple "[DONE]" string (not JSON encoded)
 *
 * This test verifies that:
 * - JSON objects work fine in SSE events (the common case)
 * - Plain strings work fine in SSE events (JSON encoding is NOT mandatory)
 * - The "[DONE]" terminator pattern works as expected
 */
describe('SSE Inject E2E (OpenAI-style streaming with string terminator)', () => {
  let server: SSETestServer<{ context: DIContext<object, object> }>
  let context: DIContext<object, object>

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestOpenAIStyleSSEModule()] }, undefined)

    server = await SSETestServer.create(
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

  it(
    'streams JSON chunks followed by string terminator like OpenAI',
    { timeout: 10000 },
    async () => {
      const { closed } = injectPayloadSSE(server.app, openaiStyleStreamContract, {
        body: { prompt: 'Hello World', stream: true as const },
      })

      const response = await closed

      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain('text/event-stream')

      const events = parseSSEEvents(response.body)

      // Should have chunk events for each word plus a done event
      const chunkEvents = events.filter((e) => e.event === 'chunk')
      const doneEvents = events.filter((e) => e.event === 'done')

      expect(chunkEvents).toHaveLength(2) // "Hello" and "World"
      expect(doneEvents).toHaveLength(1)

      // Verify JSON chunks parse correctly as objects
      const chunk1 = JSON.parse(chunkEvents[0]!.data)
      const chunk2 = JSON.parse(chunkEvents[1]!.data)

      expect(chunk1).toEqual({
        choices: [{ delta: { content: 'Hello' } }],
      })
      expect(chunk2).toEqual({
        choices: [{ delta: { content: 'World' } }],
      })

      // Verify the done event contains a string (not necessarily "[DONE]" literal,
      // since @fastify/sse JSON-serializes the data, we get the quoted string)
      // The key point is that string data works fine in SSE events
      const doneData = doneEvents[0]!.data
      expect(typeof doneData).toBe('string')

      // The string "[DONE]" when JSON-serialized becomes "\"[DONE]\""
      // When we JSON.parse it, we get back "[DONE]"
      const parsedDone = JSON.parse(doneData)
      expect(parsedDone).toBe('[DONE]')
    },
  )

  it('handles longer prompts with multiple chunks', { timeout: 10000 }, async () => {
    const prompt = 'The quick brown fox jumps over the lazy dog'
    const words = prompt.split(' ')

    const { closed } = injectPayloadSSE(server.app, openaiStyleStreamContract, {
      body: { prompt, stream: true as const },
    })

    const response = await closed
    const events = parseSSEEvents(response.body)

    const chunkEvents = events.filter((e) => e.event === 'chunk')
    const doneEvents = events.filter((e) => e.event === 'done')

    // Should have one chunk per word
    expect(chunkEvents).toHaveLength(words.length)
    expect(doneEvents).toHaveLength(1)

    // Verify all words are streamed in order
    for (let i = 0; i < words.length; i++) {
      const chunk = JSON.parse(chunkEvents[i]!.data)
      expect(chunk.choices[0].delta.content).toBe(words[i])
    }

    // Verify string terminator
    expect(JSON.parse(doneEvents[0]!.data)).toBe('[DONE]')
  })

  it('demonstrates that string data works in SSE events', { timeout: 10000 }, async () => {
    // This test specifically demonstrates that JSON encoding is NOT mandatory
    // for SSE data - strings work just fine
    const { closed } = injectPayloadSSE(server.app, openaiStyleStreamContract, {
      body: { prompt: 'Test', stream: true as const },
    })

    const response = await closed
    const events = parseSSEEvents(response.body)

    // Find the done event which contains a string, not an object
    const doneEvent = events.find((e) => e.event === 'done')
    expect(doneEvent).toBeDefined()

    // The raw data is a JSON-serialized string
    // This proves strings can be sent through SSE
    const rawData = doneEvent!.data
    expect(typeof rawData).toBe('string')

    // When parsed, we get the original string value
    const parsed = JSON.parse(rawData)
    expect(typeof parsed).toBe('string')
    expect(parsed).toBe('[DONE]')
  })
})

describe('SSE Inject E2E (onClose error handling)', () => {
  it('logs error when onClose callback throws', { timeout: 10000 }, async () => {
    const mockLogger: SSELogger = {
      error: vi.fn(),
    }

    const container = createContainer({ injectionMode: 'PROXY' })
    const context = new DIContext<TestOnCloseErrorSSEModuleDependencies, object>(
      container,
      { isTestMode: true },
      {},
    )
    context.registerDependencies(
      { modules: [new TestOnCloseErrorSSEModule(mockLogger)] },
      undefined,
    )

    const server = await SSETestServer.create(
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

    const { closed } = injectSSE(server.app, onCloseErrorStreamContract, {})

    const response = await closed

    expect(response.statusCode).toBe(200)

    const events = parseSSEEvents(response.body)
    expect(events).toHaveLength(1)
    expect(events[0]!.event).toBe('message')
    expect(JSON.parse(events[0]!.data)).toEqual({ text: 'Hello before close' })

    // The logger.error should have been called when onClose threw
    // Note: This may be called asynchronously after the response completes
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(mockLogger.error).toHaveBeenCalled()

    await context.destroy()
    await server.close()
  })

  it(
    'passes reason "server" to onClose when server closes connection',
    { timeout: 10000 },
    async () => {
      const onCloseReason = vi.fn()
      const mockLogger: SSELogger = { error: vi.fn() }

      const container = createContainer({ injectionMode: 'PROXY' })
      const context = new DIContext<object, object>(container, { isTestMode: true }, {})
      context.registerDependencies(
        { modules: [new TestOnCloseErrorSSEModule(mockLogger)] },
        undefined,
      )

      const controller = context.diContainer.resolve(
        'testOnCloseErrorSSEController',
      ) as TestOnCloseErrorSSEController

      const server = await SSETestServer.create(
        (app) => {
          app.route(
            buildFastifyRoute(controller, {
              contract: onCloseErrorStreamContract,
              handlers: {
                sse: async (_request, sse) => {
                  const connection = sse.start('autoClose')
                  await connection.send('message', { text: 'Hello' })
                  // Server explicitly closes connection (autoClose mode)
                },
              },
              options: {
                onClose: (_conn, reason) => {
                  onCloseReason(reason)
                },
              },
            }),
          )
        },
        {
          configureApp: (app) => {
            app.setValidatorCompiler(validatorCompiler)
            app.setSerializerCompiler(serializerCompiler)
          },
          setup: () => ({ context }),
        },
      )

      const { closed } = injectSSE(server.app, onCloseErrorStreamContract, {})

      await closed

      // Wait for async callbacks to complete
      await new Promise((resolve) => setTimeout(resolve, 100))

      // onClose should have been called with reason 'server'
      expect(onCloseReason).toHaveBeenCalledTimes(1)
      expect(onCloseReason).toHaveBeenCalledWith('server')

      await context.destroy()
      await server.close()
    },
  )
})

describe('SSE Inject E2E (isConnected method)', () => {
  let server: SSETestServer<{ context: DIContext<object, object> }>
  let context: DIContext<object, object>

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestIsConnectedSSEModule()] }, undefined)

    server = await SSETestServer.create(
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

  it('reports connected status correctly', { timeout: 10000 }, async () => {
    const { closed } = injectSSE(server.app, isConnectedTestStreamContract, {})

    const response = await closed

    expect(response.statusCode).toBe(200)

    const events = parseSSEEvents(response.body)
    expect(events).toHaveLength(2)

    const statusEvent = events.find((e) => e.event === 'status')
    expect(statusEvent).toBeDefined()
    expect(JSON.parse(statusEvent!.data)).toEqual({ connected: true })

    const doneEvent = events.find((e) => e.event === 'done')
    expect(doneEvent).toBeDefined()
    expect(JSON.parse(doneEvent!.data)).toEqual({ ok: true })
  })
})

describe('SSE Inject E2E (sendStream method)', () => {
  let server: SSETestServer<{ context: DIContext<object, object> }>
  let context: DIContext<object, object>

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestSendStreamSSEModule()] }, undefined)

    server = await SSETestServer.create(
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

  it('sends valid messages via sendStream', { timeout: 10000 }, async () => {
    const { closed } = injectPayloadSSE(server.app, sendStreamTestContract, {
      body: { sendInvalid: false },
    })

    const response = await closed

    expect(response.statusCode).toBe(200)

    const events = parseSSEEvents(response.body)
    expect(events).toHaveLength(2)

    const messageEvent = events.find((e) => e.event === 'message')
    expect(messageEvent).toBeDefined()
    expect(JSON.parse(messageEvent!.data)).toEqual({ text: 'First message' })

    const doneEvent = events.find((e) => e.event === 'done')
    expect(doneEvent).toBeDefined()
    expect(JSON.parse(doneEvent!.data)).toEqual({ ok: true })
  })

  it('throws error when sendStream receives invalid data', { timeout: 10000 }, async () => {
    const { closed } = injectPayloadSSE(server.app, sendStreamTestContract, {
      body: { sendInvalid: true },
    })

    const response = await closed

    // The error should be handled and an error event should be sent
    expect(response.statusCode).toBe(200)

    const events = parseSSEEvents(response.body)

    // Should have received the first message before the validation error
    const messageEvent = events.find((e) => e.event === 'message')
    expect(messageEvent).toBeDefined()

    // Should have an error event due to validation failure
    const errorEvent = events.find((e) => e.event === 'error')
    expect(errorEvent).toBeDefined()
    const errorData = JSON.parse(errorEvent!.data)
    expect(errorData.message).toContain('SSE event validation failed')
  })
})

describe('SSE Inject E2E (getStream method)', () => {
  let server: SSETestServer<{ context: DIContext<object, object> }>
  let context: DIContext<object, object>

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestGetStreamSSEModule()] }, undefined)

    server = await SSETestServer.create(
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

  it('provides access to raw stream', { timeout: 10000 }, async () => {
    const { closed } = injectSSE(server.app, getStreamTestContract, {})

    const response = await closed

    expect(response.statusCode).toBe(200)

    const events = parseSSEEvents(response.body)
    expect(events).toHaveLength(1)

    const messageEvent = events.find((e) => e.event === 'message')
    expect(messageEvent).toBeDefined()
    expect(JSON.parse(messageEvent!.data)).toEqual({ text: 'Got stream successfully' })
  })
})

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

describe('SSE Inject E2E (deprecated setupSSESession)', () => {
  it('setupSSESession backwards compat function works', { timeout: 10000 }, async () => {
    const { setupSSESession } = await import('../../lib/routes/fastifyRouteUtils.js')
    const { z } = await import('zod/v4')

    // Create event schemas directly
    const eventSchemas = {
      message: z.object({ text: z.string() }),
    }

    const container = createContainer({ injectionMode: 'PROXY' })
    const context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestSSEModule()] }, undefined)

    // Get the controller from the module
    const controller = context.diContainer.resolve<TestSSEController>('testSSEController')

    const server = await SSETestServer.create(
      (app) => {
        // Use the deprecated setupSSESession directly in a custom route
        app.route({
          method: 'GET',
          url: '/test/legacy-setup',
          sse: true,
          handler: async (request, reply) => {
            const result = await setupSSESession(
              controller,
              request,
              reply,
              eventSchemas,
              undefined,
              'LegacyTest',
            )

            await result.connection.send('message', { text: 'from legacy setup' })

            // Close connection
            result.sseReply.sse.close()
            await result.connectionClosed
          },
        })
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
      method: 'GET',
      url: '/test/legacy-setup',
      headers: { accept: 'text/event-stream' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/event-stream')

    const events = parseSSEEvents(response.body)
    expect(events).toHaveLength(1)
    expect(events[0]!.event).toBe('message')
    expect(JSON.parse(events[0]!.data)).toEqual({ text: 'from legacy setup' })

    await context.destroy()
    await server.close()
  })
})

describe('SSE Inject E2E (sendHeaders and context helpers)', () => {
  it('sendHeaders() sends SSE headers for manual streaming', { timeout: 10000 }, async () => {
    const { createSSEContext } = await import('../../lib/routes/fastifyRouteUtils.js')
    const { z } = await import('zod/v4')

    const container = createContainer({ injectionMode: 'PROXY' })
    const context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestSSEModule()] }, undefined)

    const controller = context.diContainer.resolve<TestSSEController>('testSSEController')

    const server = await SSETestServer.create(
      (app) => {
        app.route({
          method: 'GET',
          url: '/test/send-headers',
          sse: true,
          handler: (request, reply) => {
            const eventSchemas = { message: z.object({ text: z.string() }) }
            const result = createSSEContext(controller, request, reply, eventSchemas, undefined)

            // Use sendHeaders for manual control
            result.sseContext.sendHeaders()

            // Use reply.sse directly for manual event sending
            result.sseReply.sse.send({ event: 'message', data: JSON.stringify({ text: 'manual' }) })

            // Close via reply.sse
            result.sseReply.sse.close()
          },
        })
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
      method: 'GET',
      url: '/test/send-headers',
      headers: { accept: 'text/event-stream' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/event-stream')

    const events = parseSSEEvents(response.body)
    expect(events).toHaveLength(1)
    expect(events[0]!.event).toBe('message')

    await context.destroy()
    await server.close()
  })

  it('hasResponse() returns true after sse.respond() is called', { timeout: 10000 }, async () => {
    const { createSSEContext } = await import('../../lib/routes/fastifyRouteUtils.js')
    const { z } = await import('zod/v4')

    const container = createContainer({ injectionMode: 'PROXY' })
    const context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestSSEModule()] }, undefined)

    const controller = context.diContainer.resolve<TestSSEController>('testSSEController')
    let hasErrorResult = false

    const server = await SSETestServer.create(
      (app) => {
        app.route({
          method: 'GET',
          url: '/test/has-error',
          sse: true,
          handler: (request, reply) => {
            const eventSchemas = { message: z.object({ text: z.string() }) }
            const result = createSSEContext(controller, request, reply, eventSchemas, undefined)

            // Call respond
            const respondResult = result.sseContext.respond(400, { error: 'test' })

            // Check hasError
            hasErrorResult = result.hasResponse()

            // Process the respond result
            reply.code(respondResult.code).send(respondResult.body)
          },
        })
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
      method: 'GET',
      url: '/test/has-error',
      headers: { accept: 'text/event-stream' },
    })

    expect(response.statusCode).toBe(400)
    expect(hasErrorResult).toBe(true)

    await context.destroy()
    await server.close()
  })

  it('sendHeaders() throws if called after start()', { timeout: 10000 }, async () => {
    const { createSSEContext } = await import('../../lib/routes/fastifyRouteUtils.js')
    const { z } = await import('zod/v4')

    const container = createContainer({ injectionMode: 'PROXY' })
    const context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestSSEModule()] }, undefined)

    const controller = context.diContainer.resolve<TestSSEController>('testSSEController')
    let thrownError: Error | null = null

    const server = await SSETestServer.create(
      (app) => {
        app.route({
          method: 'GET',
          url: '/test/send-headers-after-start',
          sse: true,
          handler: async (request, reply) => {
            const eventSchemas = { message: z.object({ text: z.string() }) }
            const result = createSSEContext(controller, request, reply, eventSchemas, undefined)

            // First start streaming
            const connection = result.sseContext.start('autoClose')

            // Then try sendHeaders - should throw
            try {
              result.sseContext.sendHeaders()
            } catch (e) {
              thrownError = e as Error
            }

            await connection.send('message', { text: 'test' })
            result.sseReply.sse.close()
            await result.connectionClosed
          },
        })
      },
      {
        configureApp: (app) => {
          app.setValidatorCompiler(validatorCompiler)
          app.setSerializerCompiler(serializerCompiler)
        },
        setup: () => ({ context }),
      },
    )

    await server.app.inject({
      method: 'GET',
      url: '/test/send-headers-after-start',
      headers: { accept: 'text/event-stream' },
    })

    expect(thrownError).not.toBeNull()
    expect(thrownError!.message).toContain('Headers already sent')

    await context.destroy()
    await server.close()
  })

  it('sendHeaders() throws if called after respond()', { timeout: 10000 }, async () => {
    const { createSSEContext } = await import('../../lib/routes/fastifyRouteUtils.js')
    const { z } = await import('zod/v4')

    const container = createContainer({ injectionMode: 'PROXY' })
    const context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestSSEModule()] }, undefined)

    const controller = context.diContainer.resolve<TestSSEController>('testSSEController')
    let thrownError: Error | null = null

    const server = await SSETestServer.create(
      (app) => {
        app.route({
          method: 'GET',
          url: '/test/send-headers-after-respond',
          sse: true,
          handler: (request, reply) => {
            const eventSchemas = { message: z.object({ text: z.string() }) }
            const result = createSSEContext(controller, request, reply, eventSchemas, undefined)

            // First send response
            const respondResult = result.sseContext.respond(400, { error: 'test' })

            // Then try sendHeaders - should throw
            try {
              result.sseContext.sendHeaders()
            } catch (e) {
              thrownError = e as Error
            }

            reply.code(respondResult.code).send(respondResult.body)
          },
        })
      },
      {
        configureApp: (app) => {
          app.setValidatorCompiler(validatorCompiler)
          app.setSerializerCompiler(serializerCompiler)
        },
        setup: () => ({ context }),
      },
    )

    await server.app.inject({
      method: 'GET',
      url: '/test/send-headers-after-respond',
      headers: { accept: 'text/event-stream' },
    })

    expect(thrownError).not.toBeNull()
    expect(thrownError!.message).toContain('Cannot send headers after sending a response')

    await context.destroy()
    await server.close()
  })

  it('start() throws if called twice', { timeout: 10000 }, async () => {
    const { createSSEContext } = await import('../../lib/routes/fastifyRouteUtils.js')
    const { z } = await import('zod/v4')

    const container = createContainer({ injectionMode: 'PROXY' })
    const context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestSSEModule()] }, undefined)

    const controller = context.diContainer.resolve<TestSSEController>('testSSEController')
    let thrownError: Error | null = null

    const server = await SSETestServer.create(
      (app) => {
        app.route({
          method: 'GET',
          url: '/test/start-twice',
          sse: true,
          handler: async (request, reply) => {
            const eventSchemas = { message: z.object({ text: z.string() }) }
            const result = createSSEContext(controller, request, reply, eventSchemas, undefined)

            // First start
            const connection = result.sseContext.start('autoClose')

            // Try to start again - should throw
            try {
              result.sseContext.start('autoClose')
            } catch (e) {
              thrownError = e as Error
            }

            await connection.send('message', { text: 'test' })
            result.sseReply.sse.close()
            await result.connectionClosed
          },
        })
      },
      {
        configureApp: (app) => {
          app.setValidatorCompiler(validatorCompiler)
          app.setSerializerCompiler(serializerCompiler)
        },
        setup: () => ({ context }),
      },
    )

    await server.app.inject({
      method: 'GET',
      url: '/test/start-twice',
      headers: { accept: 'text/event-stream' },
    })

    expect(thrownError).not.toBeNull()
    expect(thrownError!.message).toContain('SSE streaming already started')

    await context.destroy()
    await server.close()
  })

  it('start() throws if called after respond()', { timeout: 10000 }, async () => {
    const { createSSEContext } = await import('../../lib/routes/fastifyRouteUtils.js')
    const { z } = await import('zod/v4')

    const container = createContainer({ injectionMode: 'PROXY' })
    const context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestSSEModule()] }, undefined)

    const controller = context.diContainer.resolve<TestSSEController>('testSSEController')
    let thrownError: Error | null = null

    const server = await SSETestServer.create(
      (app) => {
        app.route({
          method: 'GET',
          url: '/test/start-after-respond',
          sse: true,
          handler: (request, reply) => {
            const eventSchemas = { message: z.object({ text: z.string() }) }
            const result = createSSEContext(controller, request, reply, eventSchemas, undefined)

            // First send response
            const respondResult = result.sseContext.respond(400, { error: 'test' })

            // Try to start - should throw
            try {
              result.sseContext.start('autoClose')
            } catch (e) {
              thrownError = e as Error
            }

            reply.code(respondResult.code).send(respondResult.body)
          },
        })
      },
      {
        configureApp: (app) => {
          app.setValidatorCompiler(validatorCompiler)
          app.setSerializerCompiler(serializerCompiler)
        },
        setup: () => ({ context }),
      },
    )

    await server.app.inject({
      method: 'GET',
      url: '/test/start-after-respond',
      headers: { accept: 'text/event-stream' },
    })

    expect(thrownError).not.toBeNull()
    expect(thrownError!.message).toContain('Cannot start streaming after sending a response')

    await context.destroy()
    await server.close()
  })

  it('respond() throws if called after start()', { timeout: 10000 }, async () => {
    const { createSSEContext } = await import('../../lib/routes/fastifyRouteUtils.js')
    const { z } = await import('zod/v4')

    const container = createContainer({ injectionMode: 'PROXY' })
    const context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestSSEModule()] }, undefined)

    const controller = context.diContainer.resolve<TestSSEController>('testSSEController')
    let thrownError: Error | null = null

    const server = await SSETestServer.create(
      (app) => {
        app.route({
          method: 'GET',
          url: '/test/respond-after-start',
          sse: true,
          handler: async (request, reply) => {
            const eventSchemas = { message: z.object({ text: z.string() }) }
            const result = createSSEContext(controller, request, reply, eventSchemas, undefined)

            // First start streaming
            const session = result.sseContext.start('autoClose')

            // Then try respond - should throw
            try {
              result.sseContext.respond(400, { error: 'test' })
            } catch (e) {
              thrownError = e as Error
            }

            await session.send('message', { text: 'test' })
            result.sseReply.sse.close()
            await result.connectionClosed
          },
        })
      },
      {
        configureApp: (app) => {
          app.setValidatorCompiler(validatorCompiler)
          app.setSerializerCompiler(serializerCompiler)
        },
        setup: () => ({ context }),
      },
    )

    await server.app.inject({
      method: 'GET',
      url: '/test/respond-after-start',
      headers: { accept: 'text/event-stream' },
    })

    expect(thrownError).not.toBeNull()
    expect(thrownError!.message).toContain('Cannot send response after streaming')

    await context.destroy()
    await server.close()
  })

  it('getConnection() returns connection after start()', { timeout: 10000 }, async () => {
    const { createSSEContext } = await import('../../lib/routes/fastifyRouteUtils.js')
    const { z } = await import('zod/v4')

    const container = createContainer({ injectionMode: 'PROXY' })
    const context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestSSEModule()] }, undefined)

    const controller = context.diContainer.resolve<TestSSEController>('testSSEController')
    let connectionFromGetter: unknown = null

    const server = await SSETestServer.create(
      (app) => {
        app.route({
          method: 'GET',
          url: '/test/get-connection',
          sse: true,
          handler: async (request, reply) => {
            const eventSchemas = { message: z.object({ text: z.string() }) }
            const result = createSSEContext(controller, request, reply, eventSchemas, undefined)

            // Start streaming
            const connection = result.sseContext.start('autoClose')

            // Get connection from getter
            connectionFromGetter = result.getConnection()

            await connection.send('message', { text: 'test' })
            result.sseReply.sse.close()
            await result.connectionClosed
          },
        })
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
      method: 'GET',
      url: '/test/get-connection',
      headers: { accept: 'text/event-stream' },
    })

    expect(response.statusCode).toBe(200)
    expect(connectionFromGetter).not.toBeNull()
    expect((connectionFromGetter as { id: string }).id).toBeDefined()

    await context.destroy()
    await server.close()
  })
})

describe('SSE Inject E2E (SSEInjectConnection timeout paths)', () => {
  it('waitForEvent throws on timeout', async () => {
    // Create connection with no events (empty body)
    const connection = new SSEInjectConnection({
      statusCode: 200,
      headers: {},
      body: '',
    })

    await expect(connection.waitForEvent('nonexistent', 10)).rejects.toThrow(
      'Timeout waiting for event: nonexistent',
    )
  })

  it('waitForEvents throws on timeout when not enough events', async () => {
    // Create connection with only 1 event
    const connection = new SSEInjectConnection({
      statusCode: 200,
      headers: {},
      body: 'event: test\ndata: {}\n\n',
    })

    await expect(connection.waitForEvents(5, 10)).rejects.toThrow(
      'Timeout waiting for 5 events, received 1',
    )
  })
})
