import { createContainer } from 'awilix'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DIContext, injectPayloadSSE, parseSSEEvents, SSETestServer } from '../../index.js'
import {
  chatCompletionContract,
  largeContentStreamContract,
  openaiStyleStreamContract,
} from './fixtures/testContracts.js'
import { TestOpenAIStyleSSEModule, TestPostSSEModule } from './fixtures/testModules.js'

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
