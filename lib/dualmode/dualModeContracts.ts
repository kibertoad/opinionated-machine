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
 * Definition for a dual-mode route.
 * Use `syncResponse` for the non-streaming response schema.
 *
 * @template Method - HTTP method (GET, POST, PUT, PATCH)
 * @template Params - Path parameters schema
 * @template Query - Query string parameters schema
 * @template RequestHeaders - Request headers schema
 * @template Body - Request requestBody schema (for POST/PUT/PATCH)
 * @template SyncResponse - Sync response schema (for Accept: application/json)
 * @template Events - SSE event schemas (for Accept: text/event-stream)
 * @template ResponseHeaders - Response headers schema (for sync mode)
 */
export type SimplifiedDualModeContractDefinition<
  Method extends DualModeMethod = DualModeMethod,
  Params extends z.ZodTypeAny = z.ZodTypeAny,
  Query extends z.ZodTypeAny = z.ZodTypeAny,
  RequestHeaders extends z.ZodTypeAny = z.ZodTypeAny,
  Body extends z.ZodTypeAny | undefined = undefined,
  SyncResponse extends z.ZodTypeAny = z.ZodTypeAny,
  Events extends SSEEventSchemas = SSEEventSchemas,
  ResponseHeaders extends z.ZodTypeAny | undefined = undefined,
> = {
  method: Method
  pathResolver: PathResolver<z.infer<Params>>
  params: Params
  query: Query
  requestHeaders: RequestHeaders
  requestBody: Body
  /** Sync response schema - use with `sync` handler */
  syncResponse: SyncResponse
  responseHeaders?: ResponseHeaders
  events: Events
  isDualMode: true
  isSimplified: true
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
  requestBody: z.ZodTypeAny | undefined
  /** Sync response schema */
  syncResponse: z.ZodTypeAny
  responseHeaders?: z.ZodTypeAny
  events: SSEEventSchemas
  isDualMode: true
}
