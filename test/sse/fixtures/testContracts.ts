import { buildSseContract as buildContract } from '@lokalise/api-contracts'
import { z } from 'zod'

/**
 * Simple GET SSE route for integration tests
 */
export const streamContract = buildContract({
  pathResolver: () => '/api/stream',
  params: z.object({}),
  query: z.object({ userId: z.string().optional() }),
  requestHeaders: z.object({}),
  sseEvents: { message: z.object({ text: z.string() }) },
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
  sseEvents: {
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
  method: 'post',
  pathResolver: () => '/api/chat/completions',
  params: z.object({}),
  query: z.object({}),
  requestHeaders: z.object({}),
  requestBody: z.object({
    message: z.string(),
    stream: z.literal(true),
  }),
  sseEvents: {
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
  sseEvents: {
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
  sseEvents: {
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
  sseEvents: {
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
  sseEvents: {
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
  method: 'post',
  pathResolver: () => '/api/large-content/stream',
  params: z.object({}),
  query: z.object({}),
  requestHeaders: z.object({}),
  requestBody: z.object({
    chunkCount: z.number(),
    chunkSize: z.number(),
  }),
  sseEvents: {
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
  sseEvents: {
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
  sseEvents: {
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
  sseEvents: {
    event: z.object({ id: z.string(), data: z.string() }),
  },
})

/**
 * POST SSE route for testing event validation with strict schemas.
 * The handler sends the provided eventData as an event, allowing tests
 * to verify validation behavior with different payloads.
 */
export const validationTestStreamContract = buildContract({
  method: 'post',
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
  sseEvents: {
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
  method: 'post',
  pathResolver: () => '/api/openai-style/stream',
  params: z.object({}),
  query: z.object({}),
  requestHeaders: z.object({}),
  requestBody: z.object({
    prompt: z.string(),
    stream: z.literal(true),
  }),
  sseEvents: {
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
  sseEvents: {
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
  sseEvents: {
    status: z.object({ connected: z.boolean() }),
    done: z.object({ ok: z.boolean() }),
  },
})

/**
 * POST SSE route for testing sendStream() method with validation
 */
export const sendStreamTestContract = buildContract({
  method: 'post',
  pathResolver: () => '/api/send-stream-test/stream',
  params: z.object({}),
  query: z.object({}),
  requestHeaders: z.object({}),
  requestBody: z.object({
    sendInvalid: z.boolean().optional(),
  }),
  sseEvents: {
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
  sseEvents: {
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
  sseEvents: {
    message: z.object({ text: z.string() }),
  },
})

/**
 * POST SSE route for testing deferred headers - 422 validation error
 */
export const deferredHeaders422Contract = buildContract({
  method: 'post',
  pathResolver: () => '/api/deferred/validate/stream',
  params: z.object({}),
  query: z.object({}),
  requestHeaders: z.object({}),
  requestBody: z.object({
    value: z.number(),
  }),
  sseEvents: {
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
  sseEvents: {
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
  sseEvents: {
    message: z.object({ text: z.string() }),
  },
})

/**
 * GET SSE route for testing PublicNonRecoverableError with custom status code
 */
export const publicErrorContract = buildContract({
  pathResolver: (params) => `/api/deferred/public-error/${params.statusCode}/stream`,
  params: z.object({
    statusCode: z.string(),
  }),
  query: z.object({}),
  requestHeaders: z.object({}),
  sseEvents: {
    message: z.object({ text: z.string() }),
  },
})

/**
 * GET SSE route for testing non-Error throws (e.g., string or plain object)
 */
export const nonErrorThrowContract = buildContract({
  pathResolver: () => '/api/deferred/non-error-throw/stream',
  params: z.object({}),
  query: z.object({}),
  requestHeaders: z.object({}),
  sseEvents: {
    message: z.object({ text: z.string() }),
  },
})

/**
 * GET SSE route for testing sse.respond() without explicit return
 */
export const respondWithoutReturnContract = buildContract({
  pathResolver: (params) => `/api/deferred/respond-no-return/${params.id}/stream`,
  params: z.object({
    id: z.string(),
  }),
  query: z.object({}),
  requestHeaders: z.object({}),
  sseEvents: {
    message: z.object({ text: z.string() }),
  },
})

/**
 * POST SSE route with responseSchemasByStatusCode for testing sse.respond() validation.
 * Tests that sse.respond() responses are validated against status-specific schemas.
 */
export const sseRespondValidationContract = buildContract({
  method: 'post',
  pathResolver: () => '/api/sse-respond-validation/stream',
  params: z.object({}),
  query: z.object({}),
  requestHeaders: z.object({}),
  requestBody: z.object({
    returnStatus: z.number(),
    returnValid: z.boolean(),
  }),
  responseSchemasByStatusCode: {
    400: z.object({ error: z.string(), details: z.array(z.string()) }),
    404: z.object({ error: z.string(), resourceId: z.string() }),
  },
  sseEvents: {
    message: z.object({ text: z.string() }),
  },
})

// ============================================================================
// Room Test Contracts
// ============================================================================

/**
 * GET SSE route for testing room functionality
 */
export const roomStreamContract = buildContract({
  pathResolver: (params) => `/api/rooms/${params.roomId}/stream`,
  params: z.object({
    roomId: z.string(),
  }),
  query: z.object({
    userId: z.string().optional(),
  }),
  requestHeaders: z.object({}),
  sseEvents: {
    message: z.object({
      from: z.string(),
      text: z.string(),
    }),
    userJoined: z.object({
      userId: z.string(),
    }),
    userLeft: z.object({
      userId: z.string(),
    }),
  },
})
