import type { FastifyReply, FastifyRequest } from 'fastify'
import type { z } from 'zod'
import type { AnyDualModeContractDefinition } from '../dualmode/dualModeContracts.ts'
import type { DualModeType } from '../dualmode/dualModeTypes.ts'
import type { AnySSEContractDefinition } from '../sse/sseContracts.ts'
import type { SSEEventSchemas, SSEEventSender, SSELogger, SSEMessage } from '../sse/sseTypes.ts'

// ============================================================================
// SSE Connection Types
// ============================================================================

/**
 * Represents an active SSE connection with typed event sending.
 *
 * @template Events - Event schemas for type-safe sending
 * @template Context - Custom context data stored per connection
 */
export type SSEConnection<Events extends SSEEventSchemas = SSEEventSchemas, Context = unknown> = {
  /** Unique identifier for this connection */
  id: string
  /** The original Fastify request */
  request: FastifyRequest
  /** The Fastify reply with SSE capabilities from @fastify/sse */
  reply: FastifyReply
  /** Custom context data for this connection */
  context: Context
  /** Timestamp when the connection was established */
  connectedAt: Date
  /**
   * Type-safe event sender for this connection.
   * Event names and data are validated against the contract's event schemas.
   */
  send: SSEEventSender<Events>
  /**
   * Zod schemas for validating event data.
   * Map of event name to Zod schema. Used by sendEvent for runtime validation.
   * @internal
   */
  eventSchemas?: SSEEventSchemas
}

// ============================================================================
// SSE PreHandler Types
// ============================================================================

/**
 * Async preHandler hook for SSE routes.
 *
 * IMPORTANT: SSE route preHandlers MUST return a Promise. This is required
 * for proper integration with @fastify/sse. Synchronous handlers will cause
 * connection issues.
 *
 * For rejection (auth failure), return the reply after sending:
 * ```typescript
 * preHandler: (request, reply) => {
 *   if (!validAuth) {
 *     return reply.code(401).send({ error: 'Unauthorized' })
 *   }
 *   return Promise.resolve()
 * }
 * ```
 */
export type FastifySSEPreHandler = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<unknown>

// ============================================================================
// SSE Handler Types
// ============================================================================

/**
 * Type-safe handler for SSE routes with typed event sending.
 *
 * The `connection.send` method provides compile-time type checking for event names
 * and their payloads based on the contract's event schemas.
 *
 * @template Params - Path parameters type
 * @template Query - Query string parameters type
 * @template Headers - Request headers type
 * @template Body - Request body type (for POST/PUT/PATCH)
 * @template Events - Event schemas from the contract
 * @template Context - Connection context type
 *
 * @example
 * ```typescript
 * const handler: FastifySSERouteHandler<{}, {}, {}, { message: string }, typeof contract.events> =
 *   async (request, connection) => {
 *     await connection.send('chunk', { content: request.body.message })
 *     await connection.send('done', { totalTokens: 1 })
 *   }
 * ```
 */
export type FastifySSERouteHandler<
  Params = unknown,
  Query = unknown,
  Headers = unknown,
  Body = unknown,
  Events extends SSEEventSchemas = SSEEventSchemas,
  Context = unknown,
> = (
  request: FastifyRequest<{ Params: Params; Querystring: Query; Headers: Headers; Body: Body }>,
  connection: SSEConnection<Events, Context>,
) => void | Promise<void>

/**
 * Options for configuring an SSE route.
 */
export type FastifySSERouteOptions = {
  /**
   * Async preHandler hook for authentication/authorization.
   * Runs BEFORE the SSE connection is established.
   *
   * MUST return a Promise - synchronous handlers will cause connection issues.
   * Return `reply.code(401).send(...)` for rejection, or `Promise.resolve()` for success.
   *
   * @see FastifySSEPreHandler for usage examples
   */
  preHandler?: FastifySSEPreHandler
  /**
   * Called when client connects (after SSE handshake).
   */
  onConnect?: (connection: SSEConnection) => void | Promise<void>
  /**
   * Called when client disconnects.
   */
  onDisconnect?: (connection: SSEConnection) => void | Promise<void>
  /**
   * Handler for Last-Event-ID reconnection.
   * Return an iterable of events to replay, or handle replay manually.
   * Supports both sync iterables (arrays, generators) and async iterables.
   */
  onReconnect?: (
    connection: SSEConnection,
    lastEventId: string,
  ) => Iterable<SSEMessage> | AsyncIterable<SSEMessage> | void | Promise<void>
  /**
   * Optional logger for SSE route errors.
   * If not provided, errors will be logged to console.error.
   * Compatible with CommonLogger from @lokalise/node-core and pino loggers.
   */
  logger?: SSELogger
}

/**
 * Route configuration returned by buildSSERoutes().
 *
 * @template Contract - The SSE route definition
 */
export type FastifySSEHandlerConfig<Contract extends AnySSEContractDefinition> = {
  /** The SSE route contract */
  contract: Contract
  /** Handler called when connection is established (connection has type-safe send method) */
  handler: FastifySSERouteHandler<
    z.infer<Contract['params']>,
    z.infer<Contract['query']>,
    z.infer<Contract['requestHeaders']>,
    Contract['body'] extends z.ZodTypeAny ? z.infer<Contract['body']> : undefined,
    Contract['events'],
    unknown
  >
  /** Optional route configuration */
  options?: FastifySSERouteOptions
}

/**
 * Maps SSE contracts to handler configurations for type checking.
 */
export type BuildFastifySSERoutesReturnType<
  APIContracts extends Record<string, AnySSEContractDefinition>,
> = {
  [K in keyof APIContracts]: FastifySSEHandlerConfig<APIContracts[K]>
}

/**
 * Infer the FastifyRequest type from an SSE contract.
 *
 * Use this to get properly typed request parameters in handlers without
 * manually spelling out the types.
 *
 * @example
 * ```typescript
 * const handler = async (
 *   request: InferSSERequest<typeof chatCompletionContract>,
 *   connection: SSEConnection,
 * ) => {
 *   // request.body is typed as { message: string; stream: true }
 *   const { message } = request.body
 * }
 * ```
 */
export type InferSSERequest<Contract extends AnySSEContractDefinition> = FastifyRequest<{
  Params: z.infer<Contract['params']>
  Querystring: z.infer<Contract['query']>
  Headers: z.infer<Contract['requestHeaders']>
  Body: Contract['body'] extends z.ZodTypeAny ? z.infer<Contract['body']> : undefined
}>

/**
 * Type-inference helper for Fastify SSE handlers with type-safe event sending.
 *
 * Similar to `buildFastifyPayloadRoute`, this function provides automatic
 * type inference for the request and connection parameters based on the contract.
 *
 * The `connection.send` method provides compile-time type checking:
 * - Event names must match those defined in `contract.events`
 * - Event data must match the Zod schema for that event
 *
 * @example
 * ```typescript
 * const contract = buildPayloadSSEContract({
 *   // ...
 *   events: {
 *     chunk: z.object({ content: z.string() }),
 *     done: z.object({ totalTokens: z.number() }),
 *   },
 * })
 *
 * class MyController extends AbstractSSEController<{ stream: typeof contract }> {
 *   private handleStream = buildFastifySSEHandler(
 *     contract,
 *     async (request, connection) => {
 *       // connection.send is typed - only 'chunk' and 'done' are valid event names
 *       await connection.send('chunk', { content: 'hello' })  // OK
 *       await connection.send('done', { totalTokens: 1 })     // OK
 *       // await connection.send('chunk', { totalTokens: 1 }) // TS Error: wrong payload
 *       // await connection.send('invalid', {})               // TS Error: invalid event name
 *     },
 *   )
 *
 *   buildSSERoutes() {
 *     return {
 *       stream: {
 *         contract,
 *         handler: this.handleStream,
 *       },
 *     }
 *   }
 * }
 * ```
 */
export function buildFastifySSEHandler<Contract extends AnySSEContractDefinition>(
  _contract: Contract,
  handler: FastifySSERouteHandler<
    z.infer<Contract['params']>,
    z.infer<Contract['query']>,
    z.infer<Contract['requestHeaders']>,
    Contract['body'] extends z.ZodTypeAny ? z.infer<Contract['body']> : undefined,
    Contract['events']
  >,
): typeof handler {
  return handler
}

// ============================================================================
// Dual-Mode Handler Types
// ============================================================================

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
  SyncResponse = unknown,
> = (ctx: JsonModeContext<Params, Query, Headers, Body>) => SyncResponse | Promise<SyncResponse>

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
 * @template SyncResponse - JSON response type
 * @template Events - SSE event schemas
 */
export type DualModeHandlers<
  Params = unknown,
  Query = unknown,
  Headers = unknown,
  Body = unknown,
  SyncResponse = unknown,
  Events extends SSEEventSchemas = SSEEventSchemas,
> = {
  json: JsonModeHandler<Params, Query, Headers, Body, SyncResponse>
  sse: SSEModeHandler<Events, Params, Query, Headers, Body>
}

/**
 * Options for configuring a dual-mode route.
 * Extends SSE route options with JSON-specific options.
 */
export type FastifyDualModeRouteOptions = FastifySSERouteOptions & {
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
export type FastifyDualModeHandlerConfig<Contract extends AnyDualModeContractDefinition> = {
  /** The dual-mode route contract */
  contract: Contract
  /** Handlers for JSON and SSE modes */
  handlers: DualModeHandlers<
    z.infer<Contract['params']>,
    z.infer<Contract['query']>,
    z.infer<Contract['requestHeaders']>,
    Contract['body'] extends z.ZodTypeAny ? z.infer<Contract['body']> : undefined,
    z.infer<Contract['syncResponse']>,
    Contract['events']
  >
  /** Optional route configuration */
  options?: FastifyDualModeRouteOptions
}

/**
 * Maps dual-mode contracts to handler configurations for type checking.
 */
export type BuildFastifyDualModeRoutesReturnType<
  APIContracts extends Record<string, AnyDualModeContractDefinition>,
> = {
  [K in keyof APIContracts]: FastifyDualModeHandlerConfig<APIContracts[K]>
}

/**
 * Type-inference helper for dual-mode handlers.
 *
 * Similar to `buildFastifySSEHandler`, this function provides automatic type inference
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
export function buildDualModeHandler<Contract extends AnyDualModeContractDefinition>(
  _contract: Contract,
  handlers: DualModeHandlers<
    z.infer<Contract['params']>,
    z.infer<Contract['query']>,
    z.infer<Contract['requestHeaders']>,
    Contract['body'] extends z.ZodTypeAny ? z.infer<Contract['body']> : undefined,
    z.infer<Contract['syncResponse']>,
    Contract['events']
  >,
): typeof handlers {
  return handlers
}

// ============================================================================
// Registration Options
// ============================================================================

/**
 * Options for registering SSE routes globally.
 */
export type RegisterSSERoutesOptions = {
  /**
   * Heartbeat interval in milliseconds.
   * @default 30000
   */
  heartbeatInterval?: number
  /**
   * Custom serializer for SSE message data.
   * @default JSON.stringify
   */
  serializer?: (data: unknown) => string
  /**
   * Global preHandler hooks applied to all SSE routes.
   * Use for authentication that should apply to all SSE endpoints.
   *
   * IMPORTANT: Must return a Promise for SSE compatibility.
   * Synchronous handlers will cause connection issues.
   */
  preHandler?: FastifySSEPreHandler
  /**
   * Rate limit configuration (requires @fastify/rate-limit to be registered).
   * If @fastify/rate-limit is not registered, this config is ignored.
   */
  rateLimit?: {
    /** Maximum number of connections */
    max: number
    /** Time window for rate limiting */
    timeWindow: string | number
    /** Custom key generator (e.g., for per-user limits) */
    keyGenerator?: (request: unknown) => string
  }
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
   *
   * IMPORTANT: Must return a Promise for SSE mode compatibility.
   * Synchronous handlers will cause connection issues in SSE mode.
   */
  preHandler?: FastifySSEPreHandler
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
