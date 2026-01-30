import type { FastifyReply, FastifyRequest, RouteOptions } from 'fastify'
import type { z } from 'zod'
import type {
  SSEConnection,
  SSEEventSchemas,
  SSERouteOptions,
} from '../sse/sseTypes.ts'
import type { AnyDualModeRouteDefinition } from './dualModeContracts.ts'

/**
 * Response mode determined by Accept header.
 */
export type DualModeType = 'json' | 'sse'

/**
 * Context provided to the JSON mode handler.
 *
 * @template Params - Path parameters type
 * @template Query - Query string parameters type
 * @template Headers - Request headers type
 * @template Body - Request body type
 */
export type JsonModeContext<
  Params = unknown,
  Query = unknown,
  Headers = unknown,
  Body = unknown,
> = {
  mode: 'json'
  request: FastifyRequest<{ Params: Params; Querystring: Query; Headers: Headers; Body: Body }>
  reply: FastifyReply
}

/**
 * Context provided to the SSE mode handler.
 *
 * @template Events - SSE event schemas
 * @template Params - Path parameters type
 * @template Query - Query string parameters type
 * @template Headers - Request headers type
 * @template Body - Request body type
 * @template Context - Custom context data type
 */
export type SSEModeContext<
  Events extends SSEEventSchemas = SSEEventSchemas,
  Params = unknown,
  Query = unknown,
  Headers = unknown,
  Body = unknown,
  Context = unknown,
> = {
  mode: 'sse'
  connection: SSEConnection<Events, Context>
  request: FastifyRequest<{ Params: Params; Querystring: Query; Headers: Headers; Body: Body }>
}

/**
 * Handler function for JSON mode.
 */
export type JsonModeHandler<
  Params = unknown,
  Query = unknown,
  Headers = unknown,
  Body = unknown,
  JsonResponse = unknown,
> = (ctx: JsonModeContext<Params, Query, Headers, Body>) => JsonResponse | Promise<JsonResponse>

/**
 * Handler function for SSE mode.
 */
export type SSEModeHandler<
  Events extends SSEEventSchemas = SSEEventSchemas,
  Params = unknown,
  Query = unknown,
  Headers = unknown,
  Body = unknown,
  Context = unknown,
> = (ctx: SSEModeContext<Events, Params, Query, Headers, Body, Context>) => void | Promise<void>

/**
 * Combined handlers for dual-mode routes.
 *
 * @template Params - Path parameters type
 * @template Query - Query string parameters type
 * @template Headers - Request headers type
 * @template Body - Request body type
 * @template JsonResponse - JSON response type
 * @template Events - SSE event schemas
 */
export type DualModeHandlers<
  Params = unknown,
  Query = unknown,
  Headers = unknown,
  Body = unknown,
  JsonResponse = unknown,
  Events extends SSEEventSchemas = SSEEventSchemas,
> = {
  json: JsonModeHandler<Params, Query, Headers, Body, JsonResponse>
  sse: SSEModeHandler<Events, Params, Query, Headers, Body>
}

/**
 * Options for configuring a dual-mode route.
 * Extends SSE route options with JSON-specific options.
 */
export type DualModeRouteOptions = SSERouteOptions & {
  /**
   * Default mode when Accept header doesn't specify preference.
   * @default 'json'
   */
  defaultMode?: DualModeType
}

/**
 * Handler configuration returned by buildDualModeRoutes().
 *
 * @template Contract - The dual-mode route definition
 */
export type DualModeHandlerConfig<Contract extends AnyDualModeRouteDefinition> = {
  /** The dual-mode route contract */
  contract: Contract
  /** Handlers for JSON and SSE modes */
  handlers: DualModeHandlers<
    z.infer<Contract['params']>,
    z.infer<Contract['query']>,
    z.infer<Contract['requestHeaders']>,
    Contract['body'] extends z.ZodTypeAny ? z.infer<Contract['body']> : undefined,
    z.infer<Contract['jsonResponse']>,
    Contract['events']
  >
  /** Optional route configuration */
  options?: DualModeRouteOptions
}

/**
 * Maps dual-mode contracts to handler configurations for type checking.
 */
export type BuildDualModeRoutesReturnType<
  APIContracts extends Record<string, AnyDualModeRouteDefinition>,
> = {
  [K in keyof APIContracts]: DualModeHandlerConfig<APIContracts[K]>
}

/**
 * Type-inference helper for dual-mode handlers.
 *
 * Similar to `buildSSEHandler`, this function provides automatic type inference
 * for the request parameters and handler contexts based on the contract.
 *
 * @example
 * ```typescript
 * const handlers = buildDualModeHandler(chatCompletionContract, {
 *   json: async (ctx) => {
 *     // ctx.request.body is typed from contract
 *     return { reply: 'Hello', usage: { tokens: 5 } }
 *   },
 *   sse: async (ctx) => {
 *     // ctx.connection.send is typed based on contract events
 *     await ctx.connection.send('chunk', { delta: 'Hello' })
 *     await ctx.connection.send('done', { usage: { total: 5 } })
 *   },
 * })
 * ```
 */
export function buildDualModeHandler<Contract extends AnyDualModeRouteDefinition>(
  _contract: Contract,
  handlers: DualModeHandlers<
    z.infer<Contract['params']>,
    z.infer<Contract['query']>,
    z.infer<Contract['requestHeaders']>,
    Contract['body'] extends z.ZodTypeAny ? z.infer<Contract['body']> : undefined,
    z.infer<Contract['jsonResponse']>,
    Contract['events']
  >,
): typeof handlers {
  return handlers
}

/**
 * Minimal logger interface for dual-mode route error handling.
 * Compatible with CommonLogger from @lokalise/node-core and pino loggers.
 */
export type DualModeLogger = {
  error: (obj: Record<string, unknown>, msg: string) => void
}

/**
 * Configuration options for dual-mode controllers.
 */
export type DualModeControllerConfig = {
  /**
   * Enable connection spying for testing.
   * When enabled, the controller tracks connections and allows waiting for them.
   * Only enable this in test environments.
   * @default false
   */
  enableConnectionSpy?: boolean
}

/**
 * Options for registering dual-mode routes globally.
 */
export type RegisterDualModeRoutesOptions = {
  /**
   * Heartbeat interval in milliseconds for SSE mode.
   * @default 30000
   */
  heartbeatInterval?: number
  /**
   * Custom serializer for SSE message data.
   * @default JSON.stringify
   */
  serializer?: (data: unknown) => string
  /**
   * Global preHandler hooks applied to all dual-mode routes.
   * Use for authentication that should apply to all endpoints.
   */
  preHandler?: RouteOptions['preHandler']
  /**
   * Rate limit configuration (requires @fastify/rate-limit to be registered).
   * If @fastify/rate-limit is not registered, this config is ignored.
   */
  rateLimit?: {
    /** Maximum number of requests */
    max: number
    /** Time window for rate limiting */
    timeWindow: string | number
    /** Custom key generator (e.g., for per-user limits) */
    keyGenerator?: (request: unknown) => string
  }
}
