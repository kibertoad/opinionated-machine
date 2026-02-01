import type { Either } from '@lokalise/node-core'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { z } from 'zod'
import type { AnyDualModeContractDefinition } from '../dualmode/dualModeContracts.ts'
import type { DualModeType } from '../dualmode/dualModeTypes.ts'
import type { AnySSEContractDefinition } from '../sse/sseContracts.ts'
import type { SSEEventSchemas, SSEEventSender, SSELogger, SSEMessage } from '../sse/sseTypes.ts'

// ============================================================================
// SSE Handler Result Types
// ============================================================================

/**
 * Result indicating the SSE handler completed and the connection should be closed.
 * Use this for request-response streaming patterns (e.g., AI completions).
 */
export type SSEHandlerDisconnect = 'disconnect'

/**
 * Result indicating the SSE handler completed but the connection should stay open.
 * Use this for long-lived connection patterns (e.g., notifications).
 * The connection will remain open until the client disconnects.
 */
export type SSEHandlerMaintainConnection = 'maintain_connection'

/**
 * Possible success results from an SSE handler.
 * - `'disconnect'`: Close connection after handler completes (request-response streaming)
 * - `'maintain_connection'`: Keep connection open (long-lived connections)
 */
export type SSEHandlerResult = SSEHandlerDisconnect | SSEHandlerMaintainConnection

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
  /** Handlers object containing the SSE handler */
  handlers: SSEOnlyHandlers<
    Contract['events'],
    z.infer<Contract['params']>,
    z.infer<Contract['query']>,
    z.infer<Contract['requestHeaders']>,
    Contract['body'] extends z.ZodTypeAny ? z.infer<Contract['body']> : undefined
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

// ============================================================================
// Dual-Mode Handler Types
// ============================================================================

/**
 * Handler function for JSON mode.
 * Signature matches Fastify's `(request, reply)` pattern.
 *
 * @template Params - Path parameters type
 * @template Query - Query string parameters type
 * @template Headers - Request headers type
 * @template Body - Request body type
 * @template SyncResponse - Response type that must match contract's syncResponse schema
 */
export type JsonModeHandler<
  Params = unknown,
  Query = unknown,
  Headers = unknown,
  Body = unknown,
  SyncResponse = unknown,
> = (
  request: FastifyRequest<{ Params: Params; Querystring: Query; Headers: Headers; Body: Body }>,
  reply: FastifyReply,
) => SyncResponse | Promise<SyncResponse>

/**
 * Handler function for SSE mode.
 * Returns an Either indicating success with connection action, or failure with error.
 *
 * @returns Either<Error, SSEHandlerResult> where:
 * - `success('disconnect')`: Close connection after handler completes
 * - `success('maintain_connection')`: Keep connection open for long-lived streaming
 * - `failure(error)`: Handle error and close connection
 *
 * @example
 * ```typescript
 * // Request-response streaming (AI completions)
 * sse: async (request, connection) => {
 *   await connection.send('chunk', { delta: 'Hello' })
 *   await connection.send('done', { usage: { total: 5 } })
 *   return success('disconnect')
 * }
 *
 * // Long-lived connection (notifications)
 * sse: async (request, connection) => {
 *   this.subscriptions.set(connection.id, request.params.userId)
 *   return success('maintain_connection')
 * }
 * ```
 *
 * @template Events - SSE event schemas for type-safe sending
 * @template Params - Path parameters type
 * @template Query - Query string parameters type
 * @template Headers - Request headers type
 * @template Body - Request body type
 * @template Context - Custom context data type stored per connection
 */
export type SSEModeHandler<
  Events extends SSEEventSchemas = SSEEventSchemas,
  Params = unknown,
  Query = unknown,
  Headers = unknown,
  Body = unknown,
  Context = unknown,
> = (
  request: FastifyRequest<{ Params: Params; Querystring: Query; Headers: Headers; Body: Body }>,
  connection: SSEConnection<Events, Context>,
) => Either<Error, SSEHandlerResult> | Promise<Either<Error, SSEHandlerResult>>

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

// ============================================================================
// Unified Handler Builder
// ============================================================================

/**
 * SSE-only handler object - just the SSE handler.
 * Explicitly rejects `json` property to distinguish from dual-mode handlers.
 */
export type SSEOnlyHandlers<
  Events extends SSEEventSchemas = SSEEventSchemas,
  Params = unknown,
  Query = unknown,
  Headers = unknown,
  Body = unknown,
> = {
  sse: SSEModeHandler<Events, Params, Query, Headers, Body>
  /** SSE-only contracts do not support JSON handlers */
  json?: never
}

/**
 * Infer the handler type based on contract type.
 * - SSE-only contracts: `{ sse: handler }`
 * - Dual-mode contracts: `{ json: handler, sse: handler }`
 */
export type InferHandlers<Contract> = Contract extends AnyDualModeContractDefinition
  ? DualModeHandlers<
      z.infer<Contract['params']>,
      z.infer<Contract['query']>,
      z.infer<Contract['requestHeaders']>,
      Contract['body'] extends z.ZodTypeAny ? z.infer<Contract['body']> : undefined,
      z.infer<Contract['syncResponse']>,
      Contract['events']
    >
  : Contract extends AnySSEContractDefinition
    ? SSEOnlyHandlers<
        Contract['events'],
        z.infer<Contract['params']>,
        z.infer<Contract['query']>,
        z.infer<Contract['requestHeaders']>,
        Contract['body'] extends z.ZodTypeAny ? z.infer<Contract['body']> : undefined
      >
    : never

/**
 * Helper type to infer the correct handlers type based on contract.
 */
type HandlersForContract<Contract> = Contract extends AnyDualModeContractDefinition
  ? DualModeHandlers<
      z.infer<Contract['params']>,
      z.infer<Contract['query']>,
      z.infer<Contract['requestHeaders']>,
      Contract['body'] extends z.ZodTypeAny ? z.infer<Contract['body']> : undefined,
      z.infer<Contract['syncResponse']>,
      Contract['events']
    >
  : Contract extends AnySSEContractDefinition
    ? SSEOnlyHandlers<
        Contract['events'],
        z.infer<Contract['params']>,
        z.infer<Contract['query']>,
        z.infer<Contract['requestHeaders']>,
        Contract['body'] extends z.ZodTypeAny ? z.infer<Contract['body']> : undefined
      >
    : never

/**
 * Unified handler builder for both SSE-only and dual-mode contracts.
 *
 * This function provides automatic type inference based on the contract type:
 * - **SSE-only contracts**: Provide `{ sse: handler }` only
 * - **Dual-mode contracts**: Provide both `{ json: handler, sse: handler }`
 *
 * ## Handler Signatures
 *
 * **JSON handler** (dual-mode only):
 * ```typescript
 * json: (request, reply) => SyncResponse | Promise<SyncResponse>
 * ```
 *
 * **SSE handler** (both SSE-only and dual-mode):
 * ```typescript
 * sse: (request, connection) => Either<Error, SSEHandlerResult> | Promise<Either<Error, SSEHandlerResult>>
 * ```
 *
 * The SSE handler must return an `Either` from `@lokalise/node-core`:
 * - `success('disconnect')` - Close connection after handler completes (request-response streaming)
 * - `success('maintain_connection')` - Keep connection open until client disconnects (long-lived)
 * - `failure(error)` - Signal an error; the framework sends an error event and closes the connection
 *
 * @see SSEHandlerResult for the possible success values
 * @see Either from `@lokalise/node-core` for the result wrapper
 *
 * @example
 * ```typescript
 * import { success, failure } from '@lokalise/node-core'
 *
 * // SSE-only contract - request-response streaming (e.g., AI completions)
 * const sseHandlers = buildHandler(chatStreamContract, {
 *   sse: async (request, connection) => {
 *     for (const word of request.body.message.split(' ')) {
 *       await connection.send('chunk', { delta: word })
 *     }
 *     await connection.send('done', { usage: { total: 5 } })
 *     return success('disconnect')
 *   },
 * })
 *
 * // SSE-only contract - long-lived connection (e.g., notifications)
 * const notificationHandlers = buildHandler(notificationsContract, {
 *   sse: async (request, connection) => {
 *     this.subscriptions.set(connection.id, request.params.userId)
 *     return success('maintain_connection')
 *   },
 * })
 *
 * // Dual-mode contract - supports both JSON and SSE responses
 * const dualModeHandlers = buildHandler(chatCompletionContract, {
 *   json: async (request, reply) => {
 *     reply.header('x-custom', 'value')
 *     return { reply: 'Hello', usage: { tokens: 5 } }
 *   },
 *   sse: async (request, connection) => {
 *     await connection.send('chunk', { delta: 'Hello' })
 *     await connection.send('done', { usage: { total: 5 } })
 *     return success('disconnect')
 *   },
 * })
 * ```
 */
export function buildHandler<
  Contract extends AnyDualModeContractDefinition | AnySSEContractDefinition,
>(_contract: Contract, handlers: HandlersForContract<Contract>): typeof handlers {
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
