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
export type DualModeContractDefinition<
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
export type AnyDualModeContractDefinition = {
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
export type DualModeContractConfig<
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
export type PayloadDualModeContractConfig<
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
