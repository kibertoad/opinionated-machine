import { buildSseContract as buildContract } from '@lokalise/api-contracts'
import { z } from 'zod'

/**
 * Simple POST dual-mode route without path params.
 * Used for basic Accept header routing tests.
 */
export const chatCompletionContract = buildContract({
  method: 'post',
  pathResolver: () => '/api/chat/completions',
  requestPathParamsSchema: z.object({}),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({}),
  requestBodySchema: z.object({ message: z.string() }),
  successResponseBodySchema: z.object({
    reply: z.string(),
    usage: z.object({ tokens: z.number() }),
  }),
  serverSentEventSchemas: {
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
  requestPathParamsSchema: z.object({ conversationId: z.string().uuid() }),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({ authorization: z.string() }),
  requestBodySchema: z.object({ message: z.string() }),
  successResponseBodySchema: z.object({
    reply: z.string(),
    conversationId: z.string(),
  }),
  serverSentEventSchemas: {
    chunk: z.object({ delta: z.string() }),
    done: z.object({ conversationId: z.string() }),
  },
})

/**
 * GET dual-mode route for status polling/streaming.
 */
export const jobStatusContract = buildContract({
  method: 'get',
  pathResolver: (params) => `/api/jobs/${params.jobId}/status`,
  requestPathParamsSchema: z.object({ jobId: z.string().uuid() }),
  requestQuerySchema: z.object({ verbose: z.string().optional() }),
  requestHeaderSchema: z.object({}),
  successResponseBodySchema: z.object({
    status: z.enum(['pending', 'running', 'completed', 'failed']),
    progress: z.number(),
    result: z.string().optional(),
  }),
  serverSentEventSchemas: {
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
  requestPathParamsSchema: z.object({}),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({
    authorization: z.string().optional(),
  }),
  requestBodySchema: z.object({ data: z.string() }),
  successResponseBodySchema: z.object({
    success: z.boolean(),
    data: z.string(),
  }),
  serverSentEventSchemas: {
    result: z.object({ success: z.boolean(), data: z.string() }),
  },
})

/**
 * Simple POST dual-mode route for testing default mode behavior.
 */
export const defaultModeTestContract = buildContract({
  method: 'post',
  pathResolver: () => '/api/default-mode-test',
  requestPathParamsSchema: z.object({}),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({}),
  requestBodySchema: z.object({ input: z.string() }),
  successResponseBodySchema: z.object({ output: z.string() }),
  serverSentEventSchemas: {
    output: z.object({ value: z.string() }),
  },
})

/**
 * POST dual-mode route for testing error handling in SSE mode.
 */
export const errorTestContract = buildContract({
  method: 'post',
  pathResolver: () => '/api/error-test',
  requestPathParamsSchema: z.object({}),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({}),
  requestBodySchema: z.object({ shouldThrow: z.boolean() }),
  successResponseBodySchema: z.object({ success: z.boolean() }),
  serverSentEventSchemas: {
    result: z.object({ success: z.boolean() }),
  },
})

/**
 * POST dual-mode route WITHOUT explicit method - tests the default POST behavior.
 * This covers the `config.method ?? 'post'` branch in buildContract.
 */
export const defaultMethodContract = buildContract({
  method: 'post',
  pathResolver: () => '/api/default-method-test',
  requestPathParamsSchema: z.object({}),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({}),
  requestBodySchema: z.object({ value: z.string() }),
  successResponseBodySchema: z.object({ result: z.string() }),
  serverSentEventSchemas: {
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
  requestPathParamsSchema: z.object({}),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({}),
  requestBodySchema: z.object({ returnInvalid: z.boolean() }),
  successResponseBodySchema: z.object({
    requiredField: z.string(),
    count: z.number().int().positive(),
  }),
  serverSentEventSchemas: {
    result: z.object({ success: z.boolean() }),
  },
})

/**
 * POST dual-mode route with responseSchemasByStatusCode for testing status-based validation.
 * Tests that non-2xx responses are validated against the appropriate schema.
 */
export const statusCodeValidationContract = buildContract({
  method: 'post',
  pathResolver: () => '/api/status-code-validation',
  requestPathParamsSchema: z.object({}),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({}),
  requestBodySchema: z.object({
    returnStatus: z.number(),
    returnValid: z.boolean(),
  }),
  successResponseBodySchema: z.object({
    success: z.boolean(),
    data: z.string(),
  }),
  responseBodySchemasByStatusCode: {
    400: z.object({ error: z.string(), details: z.array(z.string()) }),
    404: z.object({ error: z.string(), resourceId: z.string() }),
  },
  serverSentEventSchemas: {
    result: z.object({ success: z.boolean() }),
  },
})

// NOTE: Multi-format contracts removed - multi-format support is deprecated
