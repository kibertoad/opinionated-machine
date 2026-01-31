import type { z } from 'zod'
import type { SSEEventSchemas } from '../sse/sseTypes.ts'

/**
 * Supported HTTP methods for dual-mode routes.
 * Matches SSE methods since dual-mode extends SSE functionality.
 */
export type DualModeMethod = 'GET' | 'POST' | 'PUT' | 'PATCH'

/**
 * Path resolver type - receives typed params, returns path string.
 * This provides type-safe path construction where TypeScript enforces
 * that all required path parameters are provided.
 *
 * @example
 * ```typescript
 * // TypeScript ensures params.chatId exists and is string
 * const resolver: PathResolver<{ chatId: string }> = (params) =>
 *   `/api/chats/${params.chatId}/completions`
 * ```
 */
export type PathResolver<Params> = (params: Params) => string

/**
 * Definition for a dual-mode route with type-safe contracts.
 * Supports both JSON responses and SSE streaming on the same path.
 *
 * @template Method - HTTP method (GET, POST, PUT, PATCH)
 * @template Params - Path parameters schema
 * @template Query - Query string parameters schema
 * @template RequestHeaders - Request headers schema
 * @template Body - Request body schema (for POST/PUT/PATCH)
 * @template JsonResponse - JSON response schema (for Accept: application/json)
 * @template Events - SSE event schemas (for Accept: text/event-stream)
 */
export type DualModeRouteDefinition<
  Method extends DualModeMethod = DualModeMethod,
  Params extends z.ZodTypeAny = z.ZodTypeAny,
  Query extends z.ZodTypeAny = z.ZodTypeAny,
  RequestHeaders extends z.ZodTypeAny = z.ZodTypeAny,
  Body extends z.ZodTypeAny | undefined = undefined,
  JsonResponse extends z.ZodTypeAny = z.ZodTypeAny,
  Events extends SSEEventSchemas = SSEEventSchemas,
> = {
  method: Method
  pathResolver: PathResolver<z.infer<Params>>
  params: Params
  query: Query
  requestHeaders: RequestHeaders
  body: Body
  jsonResponse: JsonResponse
  events: Events
  isDualMode: true
}

/**
 * Type representing any dual-mode route definition (for use in generic constraints).
 * Uses a manually defined type to avoid pathResolver type incompatibilities.
 */
export type AnyDualModeRouteDefinition = {
  method: DualModeMethod
  // biome-ignore lint/suspicious/noExplicitAny: Required for compatibility with all param types
  pathResolver: PathResolver<any>
  params: z.ZodTypeAny
  query: z.ZodTypeAny
  requestHeaders: z.ZodTypeAny
  body: z.ZodTypeAny | undefined
  jsonResponse: z.ZodTypeAny
  events: SSEEventSchemas
  isDualMode: true
}

/**
 * Configuration for building a GET dual-mode route
 */
export type DualModeRouteConfig<
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
}

/**
 * Configuration for building a POST/PUT/PATCH dual-mode route with request body
 */
export type PayloadDualModeRouteConfig<
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
 * Build a GET dual-mode route definition.
 *
 * Use this for endpoints that can return either a complete JSON response
 * or stream SSE events based on the client's Accept header.
 *
 * @example
 * ```typescript
 * const statusContract = buildDualModeRoute({
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
 * ```
 */
export function buildDualModeRoute<
  Params extends z.ZodTypeAny,
  Query extends z.ZodTypeAny,
  RequestHeaders extends z.ZodTypeAny,
  JsonResponse extends z.ZodTypeAny,
  Events extends SSEEventSchemas,
>(
  config: DualModeRouteConfig<Params, Query, RequestHeaders, JsonResponse, Events>,
): DualModeRouteDefinition<'GET', Params, Query, RequestHeaders, undefined, JsonResponse, Events> {
  return {
    method: 'GET',
    pathResolver: config.pathResolver,
    params: config.params,
    query: config.query,
    requestHeaders: config.requestHeaders,
    body: undefined,
    jsonResponse: config.jsonResponse,
    events: config.events,
    isDualMode: true,
  }
}

/**
 * Build a POST/PUT/PATCH dual-mode route definition.
 *
 * Use this for endpoints that accept a request body and can return either
 * a complete JSON response or stream SSE events based on the Accept header.
 *
 * @example
 * ```typescript
 * const chatCompletionContract = buildPayloadDualModeRoute({
 *   method: 'POST',
 *   pathResolver: (params) => `/api/chats/${params.chatId}/completions`,
 *   params: z.object({ chatId: z.string().uuid() }),
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
export function buildPayloadDualModeRoute<
  Params extends z.ZodTypeAny,
  Query extends z.ZodTypeAny,
  RequestHeaders extends z.ZodTypeAny,
  Body extends z.ZodTypeAny,
  JsonResponse extends z.ZodTypeAny,
  Events extends SSEEventSchemas,
>(
  config: PayloadDualModeRouteConfig<Params, Query, RequestHeaders, Body, JsonResponse, Events>,
): DualModeRouteDefinition<
  'POST' | 'PUT' | 'PATCH',
  Params,
  Query,
  RequestHeaders,
  Body,
  JsonResponse,
  Events
> {
  return {
    method: config.method ?? 'POST',
    pathResolver: config.pathResolver,
    params: config.params,
    query: config.query,
    requestHeaders: config.requestHeaders,
    body: config.body,
    jsonResponse: config.jsonResponse,
    events: config.events,
    isDualMode: true,
  }
}
