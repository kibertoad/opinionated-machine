import type { z } from 'zod'
import type {
  MultiFormatResponses,
  PathResolver,
  SimplifiedDualModeContractDefinition,
  VerboseDualModeContractDefinition,
} from '../dualmode/dualModeContracts.ts'
import type { SSEContractDefinition, SSEPathResolver } from '../sse/sseContracts.ts'
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
  multiFormatResponses?: never
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
  multiFormatResponses?: never
}

/**
 * Configuration for building a GET dual-mode route (simplified - single JSON format).
 * Requires jsonResponse, forbids body.
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
  /** Single JSON response schema */
  jsonResponse: JsonResponse
  multiFormatResponses?: never
  /**
   * Schema for validating response headers (JSON mode only).
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
  events: Events
  body?: never
}

/**
 * Configuration for building a POST/PUT/PATCH dual-mode route with request body (simplified).
 * Requires both body and jsonResponse.
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
  body: Body
  /** Single JSON response schema */
  jsonResponse: JsonResponse
  multiFormatResponses?: never
  /**
   * Schema for validating response headers (JSON mode only).
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
  events: Events
}

/**
 * Configuration for building a GET dual-mode route with multi-format responses.
 * Has multiFormatResponses, forbids body and jsonResponse.
 */
export type MultiFormatGetContractConfig<
  Params extends z.ZodTypeAny,
  Query extends z.ZodTypeAny,
  RequestHeaders extends z.ZodTypeAny,
  Formats extends MultiFormatResponses,
  Events extends SSEEventSchemas,
  ResponseHeaders extends z.ZodTypeAny | undefined = undefined,
> = {
  pathResolver: PathResolver<z.infer<Params>>
  params: Params
  query: Query
  requestHeaders: RequestHeaders
  jsonResponse?: never
  /** Multi-format response schemas */
  multiFormatResponses: Formats
  responseHeaders?: ResponseHeaders
  events: Events
  body?: never
}

/**
 * Configuration for building a POST/PUT/PATCH dual-mode route with multi-format responses.
 * Has both body and multiFormatResponses.
 */
export type MultiFormatPayloadContractConfig<
  Params extends z.ZodTypeAny,
  Query extends z.ZodTypeAny,
  RequestHeaders extends z.ZodTypeAny,
  Body extends z.ZodTypeAny,
  Formats extends MultiFormatResponses,
  Events extends SSEEventSchemas,
  ResponseHeaders extends z.ZodTypeAny | undefined = undefined,
> = {
  method?: 'POST' | 'PUT' | 'PATCH'
  pathResolver: PathResolver<z.infer<Params>>
  params: Params
  query: Query
  requestHeaders: RequestHeaders
  body: Body
  jsonResponse?: never
  /** Multi-format response schemas */
  multiFormatResponses: Formats
  responseHeaders?: ResponseHeaders
  events: Events
}

/**
 * Unified contract builder with overloads for SSE-only, simplified dual-mode, and verbose dual-mode contracts.
 *
 * Automatically determines the contract type based on the presence of `body`, `jsonResponse`, and `multiFormatResponses`:
 *
 * | Response Config | body | Result |
 * |-----------------|------|--------|
 * | none | ❌ | SSE GET |
 * | none | ✅ | SSE POST/PUT/PATCH |
 * | jsonResponse | ❌ | Simplified Dual-mode GET |
 * | jsonResponse | ✅ | Simplified Dual-mode POST/PUT/PATCH |
 * | multiFormatResponses | ❌ | Verbose Dual-mode GET |
 * | multiFormatResponses | ✅ | Verbose Dual-mode POST/PUT/PATCH |
 *
 * @example
 * ```typescript
 * // SSE GET - no body, no jsonResponse/multiFormatResponses
 * const notificationsStream = buildContract({
 *   pathResolver: () => '/api/notifications/stream',
 *   params: z.object({}),
 *   query: z.object({ userId: z.string().optional() }),
 *   requestHeaders: z.object({}),
 *   events: { notification: z.object({ id: z.string(), message: z.string() }) },
 * })
 *
 * // Simplified dual-mode POST (recommended) - single JSON format
 * const chatCompletion = buildContract({
 *   method: 'POST',
 *   pathResolver: () => '/api/chat/completions',
 *   params: z.object({}),
 *   query: z.object({}),
 *   requestHeaders: z.object({}),
 *   body: z.object({ message: z.string() }),
 *   jsonResponse: z.object({ reply: z.string(), usage: z.object({ tokens: z.number() }) }),
 *   events: { chunk: z.object({ delta: z.string() }), done: z.object({ usage: z.object({ total: z.number() }) }) },
 * })
 *
 * // Verbose dual-mode POST - multiple format support
 * const exportData = buildContract({
 *   method: 'POST',
 *   pathResolver: () => '/api/export',
 *   params: z.object({}),
 *   query: z.object({}),
 *   requestHeaders: z.object({}),
 *   body: z.object({ format: z.string() }),
 *   multiFormatResponses: {
 *     'application/json': z.object({ data: z.array(z.unknown()) }),
 *     'text/csv': z.string(),
 *     'text/plain': z.string(),
 *   },
 *   events: { progress: z.object({ percent: z.number() }), done: z.object({ rowCount: z.number() }) },
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
    body: hasBody ? config.body : undefined,
    events: config.events,
  }
}

// Helper to determine method
function determineMethod(config: { method?: string }, hasBody: boolean, defaultMethod: string) {
  return hasBody ? (config.method ?? defaultMethod) : 'GET'
}

// Overload 1: Multi-format with body (most specific - has multiFormatResponses + body)
export function buildContract<
  Params extends z.ZodTypeAny,
  Query extends z.ZodTypeAny,
  RequestHeaders extends z.ZodTypeAny,
  Body extends z.ZodTypeAny,
  Formats extends MultiFormatResponses,
  Events extends SSEEventSchemas,
  ResponseHeaders extends z.ZodTypeAny | undefined = undefined,
>(
  config: MultiFormatPayloadContractConfig<
    Params,
    Query,
    RequestHeaders,
    Body,
    Formats,
    Events,
    ResponseHeaders
  >,
): VerboseDualModeContractDefinition<
  'POST' | 'PUT' | 'PATCH',
  Params,
  Query,
  RequestHeaders,
  Body,
  Formats,
  Events,
  ResponseHeaders
>

// Overload 2: Multi-format GET (has multiFormatResponses, body?: never)
export function buildContract<
  Params extends z.ZodTypeAny,
  Query extends z.ZodTypeAny,
  RequestHeaders extends z.ZodTypeAny,
  Formats extends MultiFormatResponses,
  Events extends SSEEventSchemas,
  ResponseHeaders extends z.ZodTypeAny | undefined = undefined,
>(
  config: MultiFormatGetContractConfig<
    Params,
    Query,
    RequestHeaders,
    Formats,
    Events,
    ResponseHeaders
  >,
): VerboseDualModeContractDefinition<
  'GET',
  Params,
  Query,
  RequestHeaders,
  undefined,
  Formats,
  Events,
  ResponseHeaders
>

// Overload 3: Simplified dual-mode with body (has jsonResponse + body)
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

// Overload 4: Simplified dual-mode GET (has jsonResponse, body?: never)
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

// Overload 5: SSE with body (has body, no response configs)
export function buildContract<
  Params extends z.ZodTypeAny,
  Query extends z.ZodTypeAny,
  RequestHeaders extends z.ZodTypeAny,
  Body extends z.ZodTypeAny,
  Events extends SSEEventSchemas,
>(
  config: SSEPayloadContractConfig<Params, Query, RequestHeaders, Body, Events>,
): SSEContractDefinition<'POST' | 'PUT' | 'PATCH', Params, Query, RequestHeaders, Body, Events>

// Overload 6: SSE GET (no body, no response configs)
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
    | MultiFormatPayloadContractConfig<any, any, any, any, any, any, any>
    // biome-ignore lint/suspicious/noExplicitAny: Union of all config types
    | MultiFormatGetContractConfig<any, any, any, any, any, any>
    // biome-ignore lint/suspicious/noExplicitAny: Union of all config types
    | DualModePayloadContractConfig<any, any, any, any, any, any, any>
    // biome-ignore lint/suspicious/noExplicitAny: Union of all config types
    | DualModeGetContractConfig<any, any, any, any, any, any>
    // biome-ignore lint/suspicious/noExplicitAny: Union of all config types
    | SSEPayloadContractConfig<any, any, any, any, any>
    // biome-ignore lint/suspicious/noExplicitAny: Union of all config types
    | SSEGetContractConfig<any, any, any, any>,
  // biome-ignore lint/suspicious/noExplicitAny: Return type depends on overload
): any {
  const hasMultiFormat =
    'multiFormatResponses' in config && config.multiFormatResponses !== undefined
  const hasJsonResponse = 'jsonResponse' in config && config.jsonResponse !== undefined
  const hasBody = 'body' in config && config.body !== undefined
  const base = buildBaseFields(config, hasBody)

  if (hasMultiFormat) {
    // Verbose multi-format contract
    return {
      ...base,
      method: determineMethod(config as { method?: string }, hasBody, 'POST'),
      multiFormatResponses: (config as { multiFormatResponses: unknown }).multiFormatResponses,
      responseHeaders: (config as { responseHeaders?: unknown }).responseHeaders,
      isDualMode: true,
      isVerbose: true,
    }
  }

  if (hasJsonResponse) {
    // Simplified single-JSON-format contract
    return {
      ...base,
      method: determineMethod(config as { method?: string }, hasBody, 'POST'),
      jsonResponse: (config as { jsonResponse: unknown }).jsonResponse,
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
