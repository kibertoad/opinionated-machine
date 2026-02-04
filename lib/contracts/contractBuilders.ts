import type { z } from 'zod'
import type {
  PathResolver,
  SimplifiedDualModeContractDefinition,
} from '../dualmode/dualModeContracts.ts'
import type { SSEContractDefinition, SSEPathResolver } from '../sse/sseContracts.ts'
import type { SSEEventSchemas } from '../sse/sseTypes.ts'

/**
 * Configuration for building a GET SSE route.
 * Forbids requestBody for GET variants.
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
  sseEvents: Events
  requestBody?: never
  syncResponseBody?: never
}

/**
 * Configuration for building a POST/PUT/PATCH SSE route with request requestBody.
 * Requires requestBody for payload variants.
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
  requestBody: Body
  sseEvents: Events
  syncResponseBody?: never
}

/**
 * Configuration for building a GET dual-mode route.
 * Requires syncResponseBody, forbids requestBody.
 */
export type DualModeGetContractConfig<
  Params extends z.ZodTypeAny,
  Query extends z.ZodTypeAny,
  RequestHeaders extends z.ZodTypeAny,
  JsonResponse extends z.ZodTypeAny,
  Events extends SSEEventSchemas,
  ResponseHeaders extends z.ZodTypeAny | undefined = undefined,
> = {
  pathResolver: PathResolver<z.infer<Params>>
  params: Params
  query: Query
  requestHeaders: RequestHeaders
  /** Single sync response schema */
  syncResponseBody: JsonResponse
  /**
   * Schema for validating response headers (sync mode only).
   * Used to define and validate headers that the server will send in the response.
   *
   * @example
   * ```ts
   * responseHeaders: z.object({
   *   'x-ratelimit-limit': z.string(),
   *   'x-ratelimit-remaining': z.string(),
   * })
   * ```
   */
  responseHeaders?: ResponseHeaders
  sseEvents: Events
  requestBody?: never
}

/**
 * Configuration for building a POST/PUT/PATCH dual-mode route with request requestBody.
 * Requires both requestBody and syncResponseBody.
 */
export type DualModePayloadContractConfig<
  Params extends z.ZodTypeAny,
  Query extends z.ZodTypeAny,
  RequestHeaders extends z.ZodTypeAny,
  Body extends z.ZodTypeAny,
  JsonResponse extends z.ZodTypeAny,
  Events extends SSEEventSchemas,
  ResponseHeaders extends z.ZodTypeAny | undefined = undefined,
> = {
  method?: 'POST' | 'PUT' | 'PATCH'
  pathResolver: PathResolver<z.infer<Params>>
  params: Params
  query: Query
  requestHeaders: RequestHeaders
  requestBody: Body
  /** Single sync response schema */
  syncResponseBody: JsonResponse
  /**
   * Schema for validating response headers (sync mode only).
   * Used to define and validate headers that the server will send in the response.
   *
   * @example
   * ```ts
   * responseHeaders: z.object({
   *   'x-ratelimit-limit': z.string(),
   *   'x-ratelimit-remaining': z.string(),
   * })
   * ```
   */
  responseHeaders?: ResponseHeaders
  sseEvents: Events
}

/**
 * Unified contract builder with overloads for SSE-only and dual-mode contracts.
 *
 * Automatically determines the contract type based on the presence of `requestBody` and `syncResponseBody`:
 *
 * | Response Config | requestBody | Result |
 * |-----------------|------|--------|
 * | none | ❌ | SSE GET |
 * | none | ✅ | SSE POST/PUT/PATCH |
 * | syncResponseBody | ❌ | Dual-mode GET |
 * | syncResponseBody | ✅ | Dual-mode POST/PUT/PATCH |
 *
 * @example
 * ```typescript
 * // SSE GET - no requestBody, no syncResponseBody
 * const notificationsStream = buildContract({
 *   pathResolver: () => '/api/notifications/stream',
 *   params: z.object({}),
 *   query: z.object({ userId: z.string().optional() }),
 *   requestHeaders: z.object({}),
 *   sseEvents: { notification: z.object({ id: z.string(), message: z.string() }) },
 * })
 *
 * // Dual-mode POST - single sync format
 * const chatCompletion = buildContract({
 *   method: 'POST',
 *   pathResolver: () => '/api/chat/completions',
 *   params: z.object({}),
 *   query: z.object({}),
 *   requestHeaders: z.object({}),
 *   requestBody: z.object({ message: z.string() }),
 *   syncResponseBody: z.object({ reply: z.string(), usage: z.object({ tokens: z.number() }) }),
 *   sseEvents: { chunk: z.object({ delta: z.string() }), done: z.object({ usage: z.object({ total: z.number() }) }) },
 * })
 * ```
 */

// Helper to build base contract fields
// biome-ignore lint/suspicious/noExplicitAny: Config union type
function buildBaseFields(config: any, hasBody: boolean) {
  return {
    pathResolver: config.pathResolver,
    params: config.params,
    query: config.query,
    requestHeaders: config.requestHeaders,
    requestBody: hasBody ? config.requestBody : undefined,
    sseEvents: config.sseEvents,
  }
}

// Helper to determine method
function determineMethod(config: { method?: string }, hasBody: boolean, defaultMethod: string) {
  return hasBody ? (config.method ?? defaultMethod) : 'GET'
}

// Overload 1: Dual-mode with requestBody (has syncResponseBody + requestBody)
export function buildContract<
  Params extends z.ZodTypeAny,
  Query extends z.ZodTypeAny,
  RequestHeaders extends z.ZodTypeAny,
  Body extends z.ZodTypeAny,
  JsonResponse extends z.ZodTypeAny,
  Events extends SSEEventSchemas,
  ResponseHeaders extends z.ZodTypeAny | undefined = undefined,
>(
  config: DualModePayloadContractConfig<
    Params,
    Query,
    RequestHeaders,
    Body,
    JsonResponse,
    Events,
    ResponseHeaders
  >,
): SimplifiedDualModeContractDefinition<
  'POST' | 'PUT' | 'PATCH',
  Params,
  Query,
  RequestHeaders,
  Body,
  JsonResponse,
  Events,
  ResponseHeaders
>

// Overload 2: Dual-mode GET (has syncResponseBody, requestBody?: never)
export function buildContract<
  Params extends z.ZodTypeAny,
  Query extends z.ZodTypeAny,
  RequestHeaders extends z.ZodTypeAny,
  JsonResponse extends z.ZodTypeAny,
  Events extends SSEEventSchemas,
  ResponseHeaders extends z.ZodTypeAny | undefined = undefined,
>(
  config: DualModeGetContractConfig<
    Params,
    Query,
    RequestHeaders,
    JsonResponse,
    Events,
    ResponseHeaders
  >,
): SimplifiedDualModeContractDefinition<
  'GET',
  Params,
  Query,
  RequestHeaders,
  undefined,
  JsonResponse,
  Events,
  ResponseHeaders
>

// Overload 3: SSE with requestBody (has requestBody, no response configs)
export function buildContract<
  Params extends z.ZodTypeAny,
  Query extends z.ZodTypeAny,
  RequestHeaders extends z.ZodTypeAny,
  Body extends z.ZodTypeAny,
  Events extends SSEEventSchemas,
>(
  config: SSEPayloadContractConfig<Params, Query, RequestHeaders, Body, Events>,
): SSEContractDefinition<'POST' | 'PUT' | 'PATCH', Params, Query, RequestHeaders, Body, Events>

// Overload 4: SSE GET (no requestBody, no response configs)
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
    | DualModePayloadContractConfig<any, any, any, any, any, any, any>
    // biome-ignore lint/suspicious/noExplicitAny: Union of all config types
    | DualModeGetContractConfig<any, any, any, any, any, any>
    // biome-ignore lint/suspicious/noExplicitAny: Union of all config types
    | SSEPayloadContractConfig<any, any, any, any, any>
    // biome-ignore lint/suspicious/noExplicitAny: Union of all config types
    | SSEGetContractConfig<any, any, any, any>,
  // biome-ignore lint/suspicious/noExplicitAny: Return type depends on overload
): any {
  const hasSyncResponseBody = 'syncResponseBody' in config && config.syncResponseBody !== undefined
  const hasBody = 'requestBody' in config && config.requestBody !== undefined
  const base = buildBaseFields(config, hasBody)

  if (hasSyncResponseBody) {
    // Dual-mode contract
    return {
      ...base,
      method: determineMethod(config as { method?: string }, hasBody, 'POST'),
      syncResponseBody: (config as { syncResponseBody: unknown }).syncResponseBody,
      responseHeaders: (config as { responseHeaders?: unknown }).responseHeaders,
      isDualMode: true,
      isSimplified: true,
    }
  }

  // SSE-only contract
  return {
    ...base,
    method: determineMethod(config as { method?: string }, hasBody, 'POST'),
    isSSE: true,
  }
}
