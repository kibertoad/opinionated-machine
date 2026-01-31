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
