import { z } from 'zod'
import { buildContract } from '../../../index.js'

/**
 * Simple GET SSE route for integration tests
 */
export const streamContract = buildContract({
  pathResolver: () => '/api/stream',
  params: z.object({}),
  query: z.object({ userId: z.string().optional() }),
  requestHeaders: z.object({}),
  events: { message: z.object({ text: z.string() }) },
})

/**
 * GET SSE route for notifications stream
 */
export const notificationsStreamContract = buildContract({
  pathResolver: () => '/api/notifications/stream',
  params: z.object({}),
  query: z.object({
    userId: z.string().optional(),
  }),
  requestHeaders: z.object({}),
  events: {
    notification: z.object({
      id: z.string(),
      message: z.string(),
    }),
  },
})

/**
 * POST SSE route for chat completions (OpenAI-style)
 */
export const chatCompletionContract = buildContract({
  method: 'POST',
  pathResolver: () => '/api/chat/completions',
  params: z.object({}),
  query: z.object({}),
  requestHeaders: z.object({}),
  requestBody: z.object({
    message: z.string(),
    stream: z.literal(true),
  }),
  events: {
    chunk: z.object({
      content: z.string(),
    }),
    done: z.object({
      totalTokens: z.number(),
    }),
  },
})

/**
 * GET SSE route with authentication header
 */
export const authenticatedStreamContract = buildContract({
  pathResolver: () => '/api/protected/stream',
  params: z.object({}),
  query: z.object({}),
  requestHeaders: z.object({
    authorization: z.string(),
  }),
  events: {
    data: z.object({
      value: z.string(),
    }),
  },
})

/**
 * GET SSE route with path params
 */
export const channelStreamContract = buildContract({
  pathResolver: (params) => `/api/channels/${params.channelId}/stream`,
  params: z.object({
    channelId: z.string(),
  }),
  query: z.object({
    since: z.string().optional(),
  }),
  requestHeaders: z.object({}),
  events: {
    message: z.object({
      id: z.string(),
      content: z.string(),
      author: z.string(),
    }),
  },
})

/**
 * GET SSE route for testing Last-Event-ID reconnection (sync replay)
 */
export const reconnectStreamContract = buildContract({
  pathResolver: () => '/api/reconnect/stream',
  params: z.object({}),
  query: z.object({}),
  requestHeaders: z.object({
    'last-event-id': z.string().optional(),
  }),
  events: {
    event: z.object({
      id: z.string(),
      data: z.string(),
    }),
  },
})

/**
 * GET SSE route for testing Last-Event-ID reconnection (async replay)
 */
export const asyncReconnectStreamContract = buildContract({
  pathResolver: () => '/api/async-reconnect/stream',
  params: z.object({}),
  query: z.object({}),
  requestHeaders: z.object({
    'last-event-id': z.string().optional(),
  }),
  events: {
    event: z.object({
      id: z.string(),
      data: z.string(),
    }),
  },
})

/**
 * POST SSE route for testing large content streaming
 * Verifies that closeConnection doesn't cut off data transfer
 */
export const largeContentStreamContract = buildContract({
  method: 'POST',
  pathResolver: () => '/api/large-content/stream',
  params: z.object({}),
  query: z.object({}),
  requestHeaders: z.object({}),
  requestBody: z.object({
    chunkCount: z.number(),
    chunkSize: z.number(),
  }),
  events: {
    chunk: z.object({
      index: z.number(),
      content: z.string(),
    }),
    done: z.object({
      totalChunks: z.number(),
      totalBytes: z.number(),
    }),
  },
})

/**
 * GET SSE route for testing logger error handling in onClose
 */
export const loggerTestStreamContract = buildContract({
  pathResolver: () => '/api/logger-test/stream',
  params: z.object({}),
  query: z.object({}),
  requestHeaders: z.object({}),
  events: {
    message: z.object({ text: z.string() }),
  },
})

/**
 * GET SSE route for testing logger error handling in onConnect
 */
export const onConnectErrorStreamContract = buildContract({
  pathResolver: () => '/api/on-connect-error/stream',
  params: z.object({}),
  query: z.object({}),
  requestHeaders: z.object({}),
  events: {
    message: z.object({ text: z.string() }),
  },
})

/**
 * GET SSE route for testing logger error handling in onReconnect
 */
export const onReconnectErrorStreamContract = buildContract({
  pathResolver: () => '/api/on-reconnect-error/stream',
  params: z.object({}),
  query: z.object({}),
  requestHeaders: z.object({
    'last-event-id': z.string().optional(),
  }),
  events: {
    event: z.object({ id: z.string(), data: z.string() }),
  },
})

/**
 * POST SSE route for testing event validation with strict schemas.
 * The handler sends the provided eventData as an event, allowing tests
 * to verify validation behavior with different payloads.
 */
export const validationTestStreamContract = buildContract({
  method: 'POST',
  pathResolver: () => '/api/validation-test/stream',
  params: z.object({}),
  query: z.object({}),
  requestHeaders: z.object({}),
  requestBody: z.object({
    // The event data to send - passed through to sendEvent
    eventData: z.object({
      id: z.string(),
      count: z.number(),
      status: z.string(),
    }),
  }),
  events: {
    // Strict schema that eventData must match
    validatedEvent: z.object({
      id: z.string().uuid(),
      count: z.number().int().positive(),
      status: z.enum(['active', 'inactive']),
    }),
    error: z.object({
      message: z.string(),
    }),
  },
})

/**
 * POST SSE route for OpenAI-style streaming with string terminator.
 * Demonstrates that JSON encoding is not mandatory - plain strings work too.
 *
 * OpenAI's streaming API sends JSON chunks and terminates with a plain "[DONE]" string:
 * ```
 * data: {"choices":[{"delta":{"content":"Hello"}}]}
 * data: {"choices":[{"delta":{"content":" World"}}]}
 * data: [DONE]
 * ```
 */
export const openaiStyleStreamContract = buildContract({
  method: 'POST',
  pathResolver: () => '/api/openai-style/stream',
  params: z.object({}),
  query: z.object({}),
  requestHeaders: z.object({}),
  requestBody: z.object({
    prompt: z.string(),
    stream: z.literal(true),
  }),
  events: {
    // JSON object events (typical streaming chunks)
    chunk: z.object({
      choices: z.array(
        z.object({
          delta: z.object({
            content: z.string(),
          }),
        }),
      ),
    }),
    // Plain string terminator - not JSON encoded
    done: z.string(),
  },
})

/**
 * GET SSE route for testing logger error handling in onClose
 */
export const onCloseErrorStreamContract = buildContract({
  pathResolver: () => '/api/on-close-error/stream',
  params: z.object({}),
  query: z.object({}),
  requestHeaders: z.object({}),
  events: {
    message: z.object({ text: z.string() }),
  },
})

/**
 * GET SSE route for testing isConnected() method
 */
export const isConnectedTestStreamContract = buildContract({
  pathResolver: () => '/api/is-connected-test/stream',
  params: z.object({}),
  query: z.object({}),
  requestHeaders: z.object({}),
  events: {
    status: z.object({ connected: z.boolean() }),
    done: z.object({ ok: z.boolean() }),
  },
})

/**
 * POST SSE route for testing sendStream() method with validation
 */
export const sendStreamTestContract = buildContract({
  method: 'POST',
  pathResolver: () => '/api/send-stream-test/stream',
  params: z.object({}),
  query: z.object({}),
  requestHeaders: z.object({}),
  requestBody: z.object({
    sendInvalid: z.boolean().optional(),
  }),
  events: {
    message: z.object({ text: z.string() }),
    done: z.object({ ok: z.boolean() }),
  },
})

/**
 * GET SSE route for testing getStream() method
 */
export const getStreamTestContract = buildContract({
  pathResolver: () => '/api/get-stream-test/stream',
  params: z.object({}),
  query: z.object({}),
  requestHeaders: z.object({}),
  events: {
    message: z.object({ text: z.string() }),
  },
})

// ============================================================================
// Deferred Headers Test Contracts
// ============================================================================

/**
 * GET SSE route for testing deferred headers - 404 before streaming
 */
export const deferredHeaders404Contract = buildContract({
  pathResolver: (params) => `/api/deferred/${params.id}/stream`,
  params: z.object({
    id: z.string(),
  }),
  query: z.object({}),
  requestHeaders: z.object({}),
  events: {
    message: z.object({ text: z.string() }),
  },
})

/**
 * POST SSE route for testing deferred headers - 422 validation error
 */
export const deferredHeaders422Contract = buildContract({
  method: 'POST',
  pathResolver: () => '/api/deferred/validate/stream',
  params: z.object({}),
  query: z.object({}),
  requestHeaders: z.object({}),
  requestBody: z.object({
    value: z.number(),
  }),
  events: {
    result: z.object({ computed: z.number() }),
  },
})

/**
 * GET SSE route for testing forgotten start() detection
 */
export const forgottenStartContract = buildContract({
  pathResolver: () => '/api/deferred/forgotten-start/stream',
  params: z.object({}),
  query: z.object({}),
  requestHeaders: z.object({}),
  events: {
    message: z.object({ text: z.string() }),
  },
})

/**
 * GET SSE route for testing error thrown after start()
 */
export const errorAfterStartContract = buildContract({
  pathResolver: () => '/api/deferred/error-after-start/stream',
  params: z.object({}),
  query: z.object({}),
  requestHeaders: z.object({}),
  events: {
    message: z.object({ text: z.string() }),
  },
})
