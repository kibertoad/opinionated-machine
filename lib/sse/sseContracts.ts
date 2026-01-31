import type { z } from 'zod'
import type { SSEEventSchemas } from './sseTypes.ts'

/**
 * Supported HTTP methods for SSE routes.
 * While traditional SSE uses GET, modern APIs (e.g., OpenAI) use POST
 * to send request parameters in the body while streaming responses.
 */
export type SSEMethod = 'GET' | 'POST' | 'PUT' | 'PATCH'

/**
 * Path resolver type - receives typed params, returns path string.
 * This provides type-safe path construction where TypeScript enforces
 * that all required path parameters are provided.
 *
 * @example
 * ```typescript
 * // TypeScript ensures params.channelId exists and is string
 * const resolver: SSEPathResolver<{ channelId: string }> = (params) =>
 *   `/api/channels/${params.channelId}/stream`
 * ```
 */
export type SSEPathResolver<Params> = (params: Params) => string

/**
 * Definition for an SSE route with type-safe contracts.
 *
 * @template Method - HTTP method (GET, POST, PUT, PATCH)
 * @template Params - Path parameters schema
 * @template Query - Query string parameters schema
 * @template RequestHeaders - Request headers schema
 * @template Body - Request body schema (for POST/PUT/PATCH)
 * @template Events - Map of event name to event data schema
 */
export type SSEContractDefinition<
  Method extends SSEMethod = SSEMethod,
  Params extends z.ZodTypeAny = z.ZodTypeAny,
  Query extends z.ZodTypeAny = z.ZodTypeAny,
  RequestHeaders extends z.ZodTypeAny = z.ZodTypeAny,
  Body extends z.ZodTypeAny | undefined = undefined,
  Events extends SSEEventSchemas = SSEEventSchemas,
> = {
  method: Method
  /**
   * Type-safe path resolver function.
   * Receives typed params and returns the URL path string.
   */
  pathResolver: SSEPathResolver<z.infer<Params>>
  params: Params
  query: Query
  requestHeaders: RequestHeaders
  body: Body
  events: Events
  isSSE: true
}

/**
 * Type representing any SSE route definition (for use in generic constraints).
 * Uses a manually defined type to avoid pathResolver type incompatibilities.
 */
export type AnySSEContractDefinition = {
  method: SSEMethod
  // biome-ignore lint/suspicious/noExplicitAny: Required for compatibility with all param types
  pathResolver: SSEPathResolver<any>
  params: z.ZodTypeAny
  query: z.ZodTypeAny
  requestHeaders: z.ZodTypeAny
  body: z.ZodTypeAny | undefined
  events: SSEEventSchemas
  isSSE: true
}

/**
 * Configuration for building a GET SSE route
 */
export type SSEContractConfig<
  Params extends z.ZodTypeAny,
  Query extends z.ZodTypeAny,
  RequestHeaders extends z.ZodTypeAny,
  Events extends SSEEventSchemas,
> = {
  /**
   * Type-safe path resolver function.
   * Receives typed params and returns the URL path string.
   */
  pathResolver: SSEPathResolver<z.infer<Params>>
  params: Params
  query: Query
  requestHeaders: RequestHeaders
  events: Events
}

/**
 * Configuration for building a POST/PUT/PATCH SSE route with request body
 */
export type PayloadSSEContractConfig<
  Params extends z.ZodTypeAny,
  Query extends z.ZodTypeAny,
  RequestHeaders extends z.ZodTypeAny,
  Body extends z.ZodTypeAny,
  Events extends SSEEventSchemas,
> = {
  method?: 'POST' | 'PUT' | 'PATCH'
  /**
   * Type-safe path resolver function.
   * Receives typed params and returns the URL path string.
   */
  pathResolver: SSEPathResolver<z.infer<Params>>
  params: Params
  query: Query
  requestHeaders: RequestHeaders
  body: Body
  events: Events
}

/**
 * Build a GET SSE route definition (traditional SSE).
 *
 * Use this for long-lived connections where the client subscribes
 * to receive events over time (e.g., notifications, real-time updates).
 *
 * @example
 * ```typescript
 * const notificationsStream = buildSSEContract({
 *   pathResolver: () => '/api/notifications/stream',
 *   params: z.object({}),
 *   query: z.object({ userId: z.string().uuid() }),
 *   requestHeaders: z.object({ authorization: z.string() }),
 *   events: {
 *     notification: z.object({ id: z.string(), message: z.string() }),
 *   },
 * })
 * ```
 */
export function buildSSEContract<
  Params extends z.ZodTypeAny,
  Query extends z.ZodTypeAny,
  RequestHeaders extends z.ZodTypeAny,
  Events extends SSEEventSchemas,
>(
  config: SSEContractConfig<Params, Query, RequestHeaders, Events>,
): SSEContractDefinition<'GET', Params, Query, RequestHeaders, undefined, Events> {
  return {
    method: 'GET',
    pathResolver: config.pathResolver,
    params: config.params,
    query: config.query,
    requestHeaders: config.requestHeaders,
    body: undefined,
    events: config.events,
    isSSE: true,
  }
}

/**
 * Build a POST/PUT/PATCH SSE route definition (OpenAI-style streaming API).
 *
 * Use this for request-response streaming where the client sends a request
 * body and receives a stream of events in response (e.g., chat completions).
 *
 * @example
 * ```typescript
 * const chatCompletionStream = buildPayloadSSEContract({
 *   method: 'POST',
 *   pathResolver: () => '/api/ai/chat/completions',
 *   params: z.object({}),
 *   query: z.object({}),
 *   requestHeaders: z.object({ authorization: z.string() }),
 *   body: z.object({
 *     model: z.string(),
 *     messages: z.array(z.object({ role: z.string(), content: z.string() })),
 *     stream: z.literal(true),
 *   }),
 *   events: {
 *     chunk: z.object({ content: z.string() }),
 *     done: z.object({ usage: z.object({ tokens: z.number() }) }),
 *   },
 * })
 * ```
 */
export function buildPayloadSSEContract<
  Params extends z.ZodTypeAny,
  Query extends z.ZodTypeAny,
  RequestHeaders extends z.ZodTypeAny,
  Body extends z.ZodTypeAny,
  Events extends SSEEventSchemas,
>(
  config: PayloadSSEContractConfig<Params, Query, RequestHeaders, Body, Events>,
): SSEContractDefinition<'POST' | 'PUT' | 'PATCH', Params, Query, RequestHeaders, Body, Events> {
  return {
    method: config.method ?? 'POST',
    pathResolver: config.pathResolver,
    params: config.params,
    query: config.query,
    requestHeaders: config.requestHeaders,
    body: config.body,
    events: config.events,
    isSSE: true,
  }
}
