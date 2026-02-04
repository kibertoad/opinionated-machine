import { buildSseContract as buildContract } from '@lokalise/api-contracts'
import { z } from 'zod'

/**
 * Simple POST dual-mode route without path params.
 * Used for basic Accept header routing tests.
 */
export const chatCompletionContract = buildContract({
  method: 'post',
  pathResolver: () => '/api/chat/completions',
  params: z.object({}),
  query: z.object({}),
  requestHeaders: z.object({}),
  requestBody: z.object({ message: z.string() }),
  syncResponseBody: z.object({
    reply: z.string(),
    usage: z.object({ tokens: z.number() }),
  }),
  sseEvents: {
    chunk: z.object({ content: z.string() }),
    done: z.object({ usage: z.object({ totalTokens: z.number() }) }),
  },
})

/**
 * POST dual-mode route with path params demonstrating type-safe pathResolver.
 */
export const conversationCompletionContract = buildContract({
  method: 'post',
  pathResolver: (params) => `/api/conversations/${params.conversationId}/completions`,
  params: z.object({ conversationId: z.string().uuid() }),
  query: z.object({}),
  requestHeaders: z.object({ authorization: z.string() }),
  requestBody: z.object({ message: z.string() }),
  syncResponseBody: z.object({
    reply: z.string(),
    conversationId: z.string(),
  }),
  sseEvents: {
    chunk: z.object({ delta: z.string() }),
    done: z.object({ conversationId: z.string() }),
  },
})

/**
 * GET dual-mode route for status polling/streaming.
 */
export const jobStatusContract = buildContract({
  pathResolver: (params) => `/api/jobs/${params.jobId}/status`,
  params: z.object({ jobId: z.string().uuid() }),
  query: z.object({ verbose: z.string().optional() }),
  requestHeaders: z.object({}),
  syncResponseBody: z.object({
    status: z.enum(['pending', 'running', 'completed', 'failed']),
    progress: z.number(),
    result: z.string().optional(),
  }),
  sseEvents: {
    progress: z.object({ percent: z.number(), message: z.string().optional() }),
    done: z.object({ result: z.string() }),
    error: z.object({ code: z.string(), message: z.string() }),
  },
})

/**
 * POST dual-mode route with authenticated header for testing preHandler.
 * Note: authorization is optional in schema so schema validation doesn't block
 * unauthenticated requests - the preHandler handles 401 responses.
 */
export const authenticatedDualModeContract = buildContract({
  method: 'post',
  pathResolver: () => '/api/protected/action',
  params: z.object({}),
  query: z.object({}),
  requestHeaders: z.object({
    authorization: z.string().optional(),
  }),
  requestBody: z.object({ data: z.string() }),
  syncResponseBody: z.object({
    success: z.boolean(),
    data: z.string(),
  }),
  sseEvents: {
    result: z.object({ success: z.boolean(), data: z.string() }),
  },
})

/**
 * Simple POST dual-mode route for testing default mode behavior.
 */
export const defaultModeTestContract = buildContract({
  method: 'post',
  pathResolver: () => '/api/default-mode-test',
  params: z.object({}),
  query: z.object({}),
  requestHeaders: z.object({}),
  requestBody: z.object({ input: z.string() }),
  syncResponseBody: z.object({ output: z.string() }),
  sseEvents: {
    output: z.object({ value: z.string() }),
  },
})

/**
 * POST dual-mode route for testing error handling in SSE mode.
 */
export const errorTestContract = buildContract({
  method: 'post',
  pathResolver: () => '/api/error-test',
  params: z.object({}),
  query: z.object({}),
  requestHeaders: z.object({}),
  requestBody: z.object({ shouldThrow: z.boolean() }),
  syncResponseBody: z.object({ success: z.boolean() }),
  sseEvents: {
    result: z.object({ success: z.boolean() }),
  },
})

/**
 * POST dual-mode route WITHOUT explicit method - tests the default POST behavior.
 * This covers the `config.method ?? 'post'` branch in buildContract.
 */
export const defaultMethodContract = buildContract({
  // method is intentionally omitted to test default behavior
  pathResolver: () => '/api/default-method-test',
  params: z.object({}),
  query: z.object({}),
  requestHeaders: z.object({}),
  requestBody: z.object({ value: z.string() }),
  syncResponseBody: z.object({ result: z.string() }),
  sseEvents: {
    data: z.object({ value: z.string() }),
  },
})

/**
 * POST dual-mode route for testing JSON response validation failure.
 * The syncResponseBody schema is strict, but the handler will return mismatched data.
 */
export const jsonValidationContract = buildContract({
  method: 'post',
  pathResolver: () => '/api/json-validation-test',
  params: z.object({}),
  query: z.object({}),
  requestHeaders: z.object({}),
  requestBody: z.object({ returnInvalid: z.boolean() }),
  syncResponseBody: z.object({
    requiredField: z.string(),
    count: z.number().int().positive(),
  }),
  sseEvents: {
    result: z.object({ success: z.boolean() }),
  },
})

// NOTE: Multi-format contracts removed - multi-format support is deprecated
