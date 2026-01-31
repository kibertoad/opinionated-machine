import { z } from 'zod'
import { buildDualModeRoute, buildPayloadDualModeRoute } from '../../../index.js'

/**
 * Simple POST dual-mode route without path params.
 * Used for basic Accept header routing tests.
 */
export const chatCompletionContract = buildPayloadDualModeRoute({
  method: 'POST',
  pathResolver: () => '/api/chat/completions',
  params: z.object({}),
  query: z.object({}),
  requestHeaders: z.object({}),
  body: z.object({ message: z.string() }),
  jsonResponse: z.object({
    reply: z.string(),
    usage: z.object({ tokens: z.number() }),
  }),
  events: {
    chunk: z.object({ delta: z.string() }),
    done: z.object({ usage: z.object({ total: z.number() }) }),
  },
})

/**
 * POST dual-mode route with path params demonstrating type-safe pathResolver.
 */
export const conversationCompletionContract = buildPayloadDualModeRoute({
  method: 'POST',
  pathResolver: (params) => `/api/conversations/${params.conversationId}/completions`,
  params: z.object({ conversationId: z.string().uuid() }),
  query: z.object({}),
  requestHeaders: z.object({ authorization: z.string() }),
  body: z.object({ message: z.string() }),
  jsonResponse: z.object({
    reply: z.string(),
    conversationId: z.string(),
  }),
  events: {
    chunk: z.object({ delta: z.string() }),
    done: z.object({ conversationId: z.string() }),
  },
})

/**
 * GET dual-mode route for status polling/streaming.
 */
export const jobStatusContract = buildDualModeRoute({
  pathResolver: (params) => `/api/jobs/${params.jobId}/status`,
  params: z.object({ jobId: z.string().uuid() }),
  query: z.object({ verbose: z.string().optional() }),
  requestHeaders: z.object({}),
  jsonResponse: z.object({
    status: z.enum(['pending', 'running', 'completed', 'failed']),
    progress: z.number(),
    result: z.string().optional(),
  }),
  events: {
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
export const authenticatedDualModeContract = buildPayloadDualModeRoute({
  method: 'POST',
  pathResolver: () => '/api/protected/action',
  params: z.object({}),
  query: z.object({}),
  requestHeaders: z.object({
    authorization: z.string().optional(),
  }),
  body: z.object({ data: z.string() }),
  jsonResponse: z.object({
    success: z.boolean(),
    data: z.string(),
  }),
  events: {
    result: z.object({ success: z.boolean(), data: z.string() }),
  },
})

/**
 * Simple POST dual-mode route for testing default mode behavior.
 */
export const defaultModeTestContract = buildPayloadDualModeRoute({
  method: 'POST',
  pathResolver: () => '/api/default-mode-test',
  params: z.object({}),
  query: z.object({}),
  requestHeaders: z.object({}),
  body: z.object({ input: z.string() }),
  jsonResponse: z.object({ output: z.string() }),
  events: {
    output: z.object({ value: z.string() }),
  },
})

/**
 * POST dual-mode route for testing error handling in SSE mode.
 */
export const errorTestContract = buildPayloadDualModeRoute({
  method: 'POST',
  pathResolver: () => '/api/error-test',
  params: z.object({}),
  query: z.object({}),
  requestHeaders: z.object({}),
  body: z.object({ shouldThrow: z.boolean() }),
  jsonResponse: z.object({ success: z.boolean() }),
  events: {
    result: z.object({ success: z.boolean() }),
  },
})

/**
 * POST dual-mode route WITHOUT explicit method - tests the default POST behavior.
 * This covers the `config.method ?? 'POST'` branch in buildPayloadDualModeRoute.
 */
export const defaultMethodContract = buildPayloadDualModeRoute({
  // method is intentionally omitted to test default behavior
  pathResolver: () => '/api/default-method-test',
  params: z.object({}),
  query: z.object({}),
  requestHeaders: z.object({}),
  body: z.object({ value: z.string() }),
  jsonResponse: z.object({ result: z.string() }),
  events: {
    data: z.object({ value: z.string() }),
  },
})

/**
 * POST dual-mode route for testing JSON response validation failure.
 * The jsonResponse schema is strict, but the handler will return mismatched data.
 */
export const jsonValidationContract = buildPayloadDualModeRoute({
  method: 'POST',
  pathResolver: () => '/api/json-validation-test',
  params: z.object({}),
  query: z.object({}),
  requestHeaders: z.object({}),
  body: z.object({ returnInvalid: z.boolean() }),
  jsonResponse: z.object({
    requiredField: z.string(),
    count: z.number().int().positive(),
  }),
  events: {
    result: z.object({ success: z.boolean() }),
  },
})
