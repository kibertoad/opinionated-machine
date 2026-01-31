import type { z } from 'zod'
import type {
  DualModeContractDefinition,
  DualModeMethod,
  PathResolver,
} from '../dualmode/dualModeContracts.ts'
import type { SSEContractDefinition, SSEMethod, SSEPathResolver } from '../sse/sseContracts.ts'
import type { SSEEventSchemas } from '../sse/sseTypes.ts'

/**
 * Configuration for building a GET SSE route.
 * Forbids body for GET variants.
 */
export type SSEGetContractConfig<
  Params extends z.ZodTypeAny,
  Query extends z.ZodTypeAny,
  RequestHeaders extends z.ZodTypeAny,
  Events extends SSEEventSchemas,
> = {
  pathResolver: SSEPathResolver<z.infer<Params>>
  params: Params
  query: Query
  requestHeaders: RequestHeaders
  events: Events
  body?: never
  jsonResponse?: never
}

/**
 * Configuration for building a POST/PUT/PATCH SSE route with request body.
 * Requires body for payload variants.
 */
export type SSEPayloadContractConfig<
  Params extends z.ZodTypeAny,
  Query extends z.ZodTypeAny,
  RequestHeaders extends z.ZodTypeAny,
  Body extends z.ZodTypeAny,
  Events extends SSEEventSchemas,
> = {
  method?: 'POST' | 'PUT' | 'PATCH'
  pathResolver: SSEPathResolver<z.infer<Params>>
  params: Params
  query: Query
  requestHeaders: RequestHeaders
  body: Body
  events: Events
  jsonResponse?: never
}

/**
 * Configuration for building a GET dual-mode route.
 * Has jsonResponse, forbids body.
 */
export type DualModeGetContractConfig<
  Params extends z.ZodTypeAny,
  Query extends z.ZodTypeAny,
  RequestHeaders extends z.ZodTypeAny,
  JsonResponse extends z.ZodTypeAny,
  Events extends SSEEventSchemas,
> = {
  pathResolver: PathResolver<z.infer<Params>>
  params: Params
  query: Query
  requestHeaders: RequestHeaders
  jsonResponse: JsonResponse
  events: Events
  body?: never
}

/**
 * Configuration for building a POST/PUT/PATCH dual-mode route with request body.
 * Has both body and jsonResponse.
 */
export type DualModePayloadContractConfig<
  Params extends z.ZodTypeAny,
  Query extends z.ZodTypeAny,
  RequestHeaders extends z.ZodTypeAny,
  Body extends z.ZodTypeAny,
  JsonResponse extends z.ZodTypeAny,
  Events extends SSEEventSchemas,
> = {
  method?: 'POST' | 'PUT' | 'PATCH'
  pathResolver: PathResolver<z.infer<Params>>
  params: Params
  query: Query
  requestHeaders: RequestHeaders
  body: Body
  jsonResponse: JsonResponse
  events: Events
}

/**
 * Unified contract builder with 4 overloads.
 *
 * Automatically determines the contract type based on the presence of `body` and `jsonResponse`:
 *
 * | jsonResponse | body | Result |
 * |--------------|------|--------|
 * | ❌ absent | ❌ absent | SSE GET |
 * | ❌ absent | ✅ present | SSE POST/PUT/PATCH |
 * | ✅ present | ❌ absent | Dual-mode GET |
 * | ✅ present | ✅ present | Dual-mode POST/PUT/PATCH |
 *
 * @example
 * ```typescript
 * // SSE GET - no body, no jsonResponse
 * const notificationsStream = buildContract({
 *   pathResolver: () => '/api/notifications/stream',
 *   params: z.object({}),
 *   query: z.object({ userId: z.string().optional() }),
 *   requestHeaders: z.object({}),
 *   events: {
 *     notification: z.object({ id: z.string(), message: z.string() }),
 *   },
 * })
 *
 * // SSE POST - has body, no jsonResponse
 * const chatCompletionStream = buildContract({
 *   method: 'POST',
 *   pathResolver: () => '/api/chat/completions',
 *   params: z.object({}),
 *   query: z.object({}),
 *   requestHeaders: z.object({}),
 *   body: z.object({ message: z.string(), stream: z.literal(true) }),
 *   events: {
 *     chunk: z.object({ content: z.string() }),
 *     done: z.object({ totalTokens: z.number() }),
 *   },
 * })
 *
 * // Dual-mode GET - has jsonResponse, no body
 * const jobStatus = buildContract({
 *   pathResolver: (params) => `/api/jobs/${params.jobId}/status`,
 *   params: z.object({ jobId: z.string().uuid() }),
 *   query: z.object({}),
 *   requestHeaders: z.object({}),
 *   jsonResponse: z.object({
 *     status: z.enum(['pending', 'running', 'completed']),
 *     progress: z.number(),
 *   }),
 *   events: {
 *     progress: z.object({ percent: z.number() }),
 *     done: z.object({ result: z.string() }),
 *   },
 * })
 *
 * // Dual-mode POST - has both body and jsonResponse
 * const chatCompletion = buildContract({
 *   method: 'POST',
 *   pathResolver: () => '/api/chat/completions',
 *   params: z.object({}),
 *   query: z.object({}),
 *   requestHeaders: z.object({ authorization: z.string() }),
 *   body: z.object({ message: z.string() }),
 *   jsonResponse: z.object({
 *     reply: z.string(),
 *     usage: z.object({ tokens: z.number() }),
 *   }),
 *   events: {
 *     chunk: z.object({ delta: z.string() }),
 *     done: z.object({ usage: z.object({ total: z.number() }) }),
 *   },
 * })
 * ```
 */
// Overload 1: Dual-mode with body (most specific - has both discriminants)
export function buildContract<
  Params extends z.ZodTypeAny,
  Query extends z.ZodTypeAny,
  RequestHeaders extends z.ZodTypeAny,
  Body extends z.ZodTypeAny,
  JsonResponse extends z.ZodTypeAny,
  Events extends SSEEventSchemas,
>(
  config: DualModePayloadContractConfig<Params, Query, RequestHeaders, Body, JsonResponse, Events>,
): DualModeContractDefinition<
  'POST' | 'PUT' | 'PATCH',
  Params,
  Query,
  RequestHeaders,
  Body,
  JsonResponse,
  Events
>

// Overload 2: Dual-mode GET (has jsonResponse, body?: never)
export function buildContract<
  Params extends z.ZodTypeAny,
  Query extends z.ZodTypeAny,
  RequestHeaders extends z.ZodTypeAny,
  JsonResponse extends z.ZodTypeAny,
  Events extends SSEEventSchemas,
>(
  config: DualModeGetContractConfig<Params, Query, RequestHeaders, JsonResponse, Events>,
): DualModeContractDefinition<'GET', Params, Query, RequestHeaders, undefined, JsonResponse, Events>

// Overload 3: SSE with body (has body, jsonResponse?: never)
export function buildContract<
  Params extends z.ZodTypeAny,
  Query extends z.ZodTypeAny,
  RequestHeaders extends z.ZodTypeAny,
  Body extends z.ZodTypeAny,
  Events extends SSEEventSchemas,
>(
  config: SSEPayloadContractConfig<Params, Query, RequestHeaders, Body, Events>,
): SSEContractDefinition<'POST' | 'PUT' | 'PATCH', Params, Query, RequestHeaders, Body, Events>

// Overload 4: SSE GET (neither body nor jsonResponse)
export function buildContract<
  Params extends z.ZodTypeAny,
  Query extends z.ZodTypeAny,
  RequestHeaders extends z.ZodTypeAny,
  Events extends SSEEventSchemas,
>(
  config: SSEGetContractConfig<Params, Query, RequestHeaders, Events>,
): SSEContractDefinition<'GET', Params, Query, RequestHeaders, undefined, Events>

// Implementation
export function buildContract(
  config: // biome-ignore lint/suspicious/noExplicitAny: Union of all config types
    | DualModePayloadContractConfig<any, any, any, any, any, any>
    // biome-ignore lint/suspicious/noExplicitAny: Union of all config types
    | DualModeGetContractConfig<any, any, any, any, any>
    // biome-ignore lint/suspicious/noExplicitAny: Union of all config types
    | SSEPayloadContractConfig<any, any, any, any, any>
    // biome-ignore lint/suspicious/noExplicitAny: Union of all config types
    | SSEGetContractConfig<any, any, any, any>,
  // biome-ignore lint/suspicious/noExplicitAny: Return type depends on overload
): any {
  const hasDualMode = 'jsonResponse' in config && config.jsonResponse !== undefined
  const hasBody = 'body' in config && config.body !== undefined

  if (hasDualMode) {
    return {
      method: hasBody ? ((config as { method?: DualModeMethod }).method ?? 'POST') : 'GET',
      pathResolver: config.pathResolver,
      params: config.params,
      query: config.query,
      requestHeaders: config.requestHeaders,
      body: hasBody ? (config as { body: unknown }).body : undefined,
      jsonResponse: (config as { jsonResponse: unknown }).jsonResponse,
      events: config.events,
      isDualMode: true,
    }
  }

  return {
    method: hasBody ? ((config as { method?: SSEMethod }).method ?? 'POST') : 'GET',
    pathResolver: config.pathResolver,
    params: config.params,
    query: config.query,
    requestHeaders: config.requestHeaders,
    body: hasBody ? (config as { body: unknown }).body : undefined,
    events: config.events,
    isSSE: true,
  }
}
