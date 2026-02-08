import { buildSseContract as buildContract } from '@lokalise/api-contracts'
import { z } from 'zod'

/**
 * Simple GET SSE route for integration tests
 */
export const streamContract = buildContract({
  method: 'get',
  pathResolver: () => '/api/stream',
  requestPathParamsSchema: z.object({}),
  requestQuerySchema: z.object({ userId: z.string().optional() }),
  requestHeaderSchema: z.object({}),
  serverSentEventSchemas: { message: z.object({ text: z.string() }) },
})

/**
 * GET SSE route for notifications stream
 */
export const notificationsStreamContract = buildContract({
  method: 'get',
  pathResolver: () => '/api/notifications/stream',
  requestPathParamsSchema: z.object({}),
  requestQuerySchema: z.object({
    userId: z.string().optional(),
  }),
  requestHeaderSchema: z.object({}),
  serverSentEventSchemas: {
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
  requestPathParamsSchema: z.object({}),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({}),
  requestBodySchema: z.object({
    message: z.string(),
    stream: z.literal(true),
  }),
  serverSentEventSchemas: {
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
  method: 'get',
  pathResolver: () => '/api/protected/stream',
  requestPathParamsSchema: z.object({}),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({
    authorization: z.string(),
  }),
  serverSentEventSchemas: {
    data: z.object({
      value: z.string(),
    }),
  },
})

/**
 * GET SSE route with path params
 */
export const channelStreamContract = buildContract({
  method: 'get',
  pathResolver: (params) => `/api/channels/${params.channelId}/stream`,
  requestPathParamsSchema: z.object({
    channelId: z.string(),
  }),
  requestQuerySchema: z.object({
    since: z.string().optional(),
  }),
  requestHeaderSchema: z.object({}),
  serverSentEventSchemas: {
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
  method: 'get',
  pathResolver: () => '/api/reconnect/stream',
  requestPathParamsSchema: z.object({}),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({
    'last-event-id': z.string().optional(),
  }),
  serverSentEventSchemas: {
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
  method: 'get',
  pathResolver: () => '/api/async-reconnect/stream',
  requestPathParamsSchema: z.object({}),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({
    'last-event-id': z.string().optional(),
  }),
  serverSentEventSchemas: {
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
  requestPathParamsSchema: z.object({}),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({}),
  requestBodySchema: z.object({
    chunkCount: z.number(),
    chunkSize: z.number(),
  }),
  serverSentEventSchemas: {
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
  method: 'get',
  pathResolver: () => '/api/logger-test/stream',
  requestPathParamsSchema: z.object({}),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({}),
  serverSentEventSchemas: {
    message: z.object({ text: z.string() }),
  },
})

/**
 * GET SSE route for testing logger error handling in onConnect
 */
export const onConnectErrorStreamContract = buildContract({
  method: 'get',
  pathResolver: () => '/api/on-connect-error/stream',
  requestPathParamsSchema: z.object({}),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({}),
  serverSentEventSchemas: {
    message: z.object({ text: z.string() }),
  },
})

/**
 * GET SSE route for testing logger error handling in onReconnect
 */
export const onReconnectErrorStreamContract = buildContract({
  method: 'get',
  pathResolver: () => '/api/on-reconnect-error/stream',
  requestPathParamsSchema: z.object({}),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({
    'last-event-id': z.string().optional(),
  }),
  serverSentEventSchemas: {
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
  requestPathParamsSchema: z.object({}),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({}),
  requestBodySchema: z.object({
    // The event data to send - passed through to sendEvent
    eventData: z.object({
      id: z.string(),
      count: z.number(),
      status: z.string(),
    }),
  }),
  serverSentEventSchemas: {
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
  requestPathParamsSchema: z.object({}),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({}),
  requestBodySchema: z.object({
    prompt: z.string(),
    stream: z.literal(true),
  }),
  serverSentEventSchemas: {
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
  method: 'get',
  pathResolver: () => '/api/on-close-error/stream',
  requestPathParamsSchema: z.object({}),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({}),
  serverSentEventSchemas: {
    message: z.object({ text: z.string() }),
  },
})

/**
 * GET SSE route for testing isConnected() method
 */
export const isConnectedTestStreamContract = buildContract({
  method: 'get',
  pathResolver: () => '/api/is-connected-test/stream',
  requestPathParamsSchema: z.object({}),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({}),
  serverSentEventSchemas: {
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
  requestPathParamsSchema: z.object({}),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({}),
  requestBodySchema: z.object({
    sendInvalid: z.boolean().optional(),
  }),
  serverSentEventSchemas: {
    message: z.object({ text: z.string() }),
    done: z.object({ ok: z.boolean() }),
  },
})

/**
 * GET SSE route for testing getStream() method
 */
export const getStreamTestContract = buildContract({
  method: 'get',
  pathResolver: () => '/api/get-stream-test/stream',
  requestPathParamsSchema: z.object({}),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({}),
  serverSentEventSchemas: {
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
  method: 'get',
  pathResolver: (params) => `/api/deferred/${params.id}/stream`,
  requestPathParamsSchema: z.object({
    id: z.string(),
  }),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({}),
  serverSentEventSchemas: {
    message: z.object({ text: z.string() }),
  },
})

/**
 * POST SSE route for testing deferred headers - 422 validation error
 */
export const deferredHeaders422Contract = buildContract({
  method: 'post',
  pathResolver: () => '/api/deferred/validate/stream',
  requestPathParamsSchema: z.object({}),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({}),
  requestBodySchema: z.object({
    value: z.number(),
  }),
  serverSentEventSchemas: {
    result: z.object({ computed: z.number() }),
  },
})

/**
 * GET SSE route for testing forgotten start() detection
 */
export const forgottenStartContract = buildContract({
  method: 'get',
  pathResolver: () => '/api/deferred/forgotten-start/stream',
  requestPathParamsSchema: z.object({}),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({}),
  serverSentEventSchemas: {
    message: z.object({ text: z.string() }),
  },
})

/**
 * GET SSE route for testing error thrown after start()
 */
export const errorAfterStartContract = buildContract({
  method: 'get',
  pathResolver: () => '/api/deferred/error-after-start/stream',
  requestPathParamsSchema: z.object({}),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({}),
  serverSentEventSchemas: {
    message: z.object({ text: z.string() }),
  },
})

/**
 * GET SSE route for testing PublicNonRecoverableError with custom status code
 */
export const publicErrorContract = buildContract({
  method: 'get',
  pathResolver: (params) => `/api/deferred/public-error/${params.statusCode}/stream`,
  requestPathParamsSchema: z.object({
    statusCode: z.string(),
  }),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({}),
  serverSentEventSchemas: {
    message: z.object({ text: z.string() }),
  },
})

/**
 * GET SSE route for testing non-Error throws (e.g., string or plain object)
 */
export const nonErrorThrowContract = buildContract({
  method: 'get',
  pathResolver: () => '/api/deferred/non-error-throw/stream',
  requestPathParamsSchema: z.object({}),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({}),
  serverSentEventSchemas: {
    message: z.object({ text: z.string() }),
  },
})

/**
 * GET SSE route for testing sse.respond() without explicit return
 */
export const respondWithoutReturnContract = buildContract({
  method: 'get',
  pathResolver: (params) => `/api/deferred/respond-no-return/${params.id}/stream`,
  requestPathParamsSchema: z.object({
    id: z.string(),
  }),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({}),
  serverSentEventSchemas: {
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
  requestPathParamsSchema: z.object({}),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({}),
  requestBodySchema: z.object({
    returnStatus: z.number(),
    returnValid: z.boolean(),
  }),
  responseBodySchemasByStatusCode: {
    400: z.object({ error: z.string(), details: z.array(z.string()) }),
    404: z.object({ error: z.string(), resourceId: z.string() }),
  },
  serverSentEventSchemas: {
    message: z.object({ text: z.string() }),
  },
})
