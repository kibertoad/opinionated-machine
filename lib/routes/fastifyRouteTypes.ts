import type { FastifyReply, FastifyRequest } from 'fastify'
import type { z } from 'zod'
import type { AnyDualModeContractDefinition } from '../dualmode/dualModeContracts.ts'
import type { DualModeType } from '../dualmode/dualModeTypes.ts'
import type { AnySSEContractDefinition } from '../sse/sseContracts.ts'
import type { SSEEventSchemas, SSEEventSender, SSELogger, SSEMessage } from '../sse/sseTypes.ts'
import type { SSECloseReason } from './fastifyRouteUtils.ts'

// ============================================================================
// SSE Handler Result Types
// ============================================================================

/**
 * Result indicating the handler returned an HTTP response before streaming started.
 * Created via `sse.respond(code, body)`.
 * Use this for early returns (validation errors, not found, etc.) before starting SSE.
 */
export type SSERespondResult = {
  _type: 'respond'
  code: number
  body: unknown
}

/**
 * Session lifetime mode, specified when calling `sse.start()`.
 * - `'autoClose'`: Close session automatically after handler completes (request-response streaming)
 * - `'keepAlive'`: Keep session open after handler completes (long-lived connections)
 */
export type SSESessionMode = 'autoClose' | 'keepAlive'

/**
 * Possible results from an SSE handler.
 * - `SSERespondResult`: Send HTTP response before streaming (via sse.respond())
 * - `void`: Streaming was started via sse.start(), mode determines what happens next
 */
// biome-ignore lint/suspicious/noConfusingVoidType: void is intentional here - handlers can return nothing after calling sse.start()
export type SSEHandlerResult = SSERespondResult | void

// ============================================================================
// SSE Session Types
// ============================================================================

/**
 * Message format for use with SSESession.sendStream().
 * Allows sending typed events through an async iterable.
 *
 * @template Events - Event schemas for type-safe event names and data
 *
 * @example
 * ```typescript
 * async function* generateMessages(): AsyncIterable<SSEStreamMessage<typeof contract.events>> {
 *   yield { event: 'chunk', data: { delta: 'Hello' } }
 *   yield { event: 'chunk', data: { delta: ' world' } }
 *   yield { event: 'done', data: { usage: { total: 2 } } }
 * }
 *
 * await connection.sendStream(generateMessages())
 * ```
 */
export type SSEStreamMessage<Events extends SSEEventSchemas = SSEEventSchemas> = {
  [K in keyof Events & string]: {
    event: K
    data: z.input<Events[K]>
    id?: string
    retry?: number
  }
}[keyof Events & string]

/**
 * Represents an active SSE connection with typed event sending.
 *
 * @template Events - Event schemas for type-safe sending
 * @template Context - Custom context data stored per connection
 */
export type SSESession<Events extends SSEEventSchemas = SSEEventSchemas, Context = unknown> = {
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
   * Check if the SSE connection is still open.
   * Queries the underlying @fastify/sse connection state.
   *
   * @returns true if the connection is still open, false if closed
   */
  isConnected: () => boolean
  /**
   * Get the underlying writable stream for advanced streaming operations.
   * Useful for piping data directly or using Node.js stream utilities.
   *
   * @returns The underlying NodeJS.WritableStream from @fastify/sse
   *
   * @example
   * ```typescript
   * import { pipeline } from 'node:stream/promises'
   *
   * // Pipe data from a readable stream to SSE
   * const readable = createReadableStream()
   * await pipeline(readable, connection.getStream())
   * ```
   */
  getStream: () => NodeJS.WritableStream
  /**
   * Send multiple SSE messages from an async iterable with validation.
   * Each message is validated against the contract's event schemas before sending.
   *
   * @param messages - Async iterable of SSE messages to send
   * @returns Promise that resolves when all messages have been sent
   *
   * @example
   * ```typescript
   * async function* generateMessages() {
   *   yield { event: 'chunk', data: { delta: 'Hello' } }
   *   yield { event: 'chunk', data: { delta: ' world' } }
   *   yield { event: 'done', data: { usage: { total: 2 } } }
   * }
   *
   * await connection.sendStream(generateMessages())
   * ```
   */
  sendStream: (messages: AsyncIterable<SSEStreamMessage<Events>>) => Promise<void>
  /**
   * Zod schemas for validating event data.
   * Map of event name to Zod schema. Used by sendEvent for runtime validation.
   * @internal
   */
  eventSchemas?: SSEEventSchemas
}

// ============================================================================
// SSE Context Types (New API)
// ============================================================================

/**
 * Options for starting an SSE connection.
 */
export type SSEStartOptions<Context = unknown> = {
  /** Initial context data for the connection */
  context?: Context
}

/**
 * Context object passed to SSE handlers for deferred header sending.
 *
 * This abstraction allows handlers to:
 * 1. Perform validation before any headers are sent
 * 2. Return early with HTTP responses (errors, redirects, etc.) before streaming
 * 3. Explicitly start streaming when ready
 *
 * @template Events - Event schemas for type-safe sending
 * @template ResponseBody - Response body type for early returns
 *
 * @example
 * ```typescript
 * sse: async (request, sse) => {
 *   // Phase 1: Validation (headers NOT sent yet)
 *   const entity = await db.find(request.params.id)
 *   if (!entity) {
 *     return sse.respond(404, { error: 'Entity not found' })
 *   }
 *
 *   // Phase 2: Start streaming (sends 200 + SSE headers)
 *   // 'autoClose' = close after handler, 'keepAlive' = keep open for external events
 *   const session = sse.start('autoClose', { context: { entity } })
 *
 *   // Phase 3: Stream events
 *   await session.send('data', { item: entity })
 * }
 * ```
 */
export type SSEContext<Events extends SSEEventSchemas = SSEEventSchemas, ResponseBody = unknown> = {
  /**
   * Start streaming - sends HTTP 200 + SSE headers, returns typed session.
   *
   * After calling this method, you can no longer send HTTP responses.
   * Use `respond()` before `start()` for early returns.
   *
   * @param mode - Session lifetime mode:
   *   - `'autoClose'`: Close session automatically after handler completes (request-response streaming)
   *   - `'keepAlive'`: Keep session open after handler completes (long-lived connections)
   * @param options - Optional configuration for the session
   * @returns SSESession for sending events
   */
  start: <Context = unknown>(
    mode: SSESessionMode,
    options?: SSEStartOptions<Context>,
  ) => SSESession<Events, Context>

  /**
   * Send an HTTP response before streaming starts (early return).
   *
   * Use this for any case where you want to return a regular HTTP response
   * instead of starting an SSE stream: validation errors, not found, redirects, etc.
   *
   * Must be called BEFORE `start()`. After calling `respond()`, the handler
   * should return immediately with the result.
   *
   * @param code - HTTP status code (e.g., 200, 404, 422)
   * @param body - Response body
   * @returns SSEHandlerResult to return from the handler
   *
   * @example
   * ```typescript
   * if (!entity) {
   *   return sse.respond(404, { error: 'Entity not found' })
   * }
   * ```
   */
  respond: (code: number, body: ResponseBody) => SSERespondResult

  /**
   * Advanced: send headers without creating a full connection.
   *
   * Use this only for advanced streaming scenarios where you need headers
   * sent early but will manage streaming manually via `sse.reply.sse`.
   *
   * Most handlers should use `start()` instead.
   */
  sendHeaders: () => void

  /**
   * Escape hatch to raw Fastify reply if needed.
   * Use with caution - prefer the typed methods above.
   */
  reply: FastifyReply
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
  onConnect?: (connection: SSESession) => void | Promise<void>
  /**
   * Called when the SSE connection closes for any reason (client disconnect,
   * network failure, or server explicitly closing via closeConnection()).
   *
   * @param connection - The connection that was closed
   * @param reason - Why the connection was closed:
   *   - 'server': Server explicitly closed (closeConnection() or success('disconnect'))
   *   - 'client': Client closed (EventSource.close(), navigation, network failure)
   *
   * Use this for cleanup like unsubscribing from events or removing from tracking.
   */
  onClose?: (connection: SSESession, reason: SSECloseReason) => void | Promise<void>
  /**
   * Handler for Last-Event-ID reconnection.
   * Return an iterable of events to replay, or handle replay manually.
   * Supports both sync iterables (arrays, generators) and async iterables.
   */
  onReconnect?: (
    connection: SSESession,
    lastEventId: string,
  ) => Iterable<SSEMessage> | AsyncIterable<SSEMessage> | void | Promise<void>
  /**
   * Optional logger for SSE route errors.
   * If not provided, errors will be logged to console.error.
   * Compatible with CommonLogger from @lokalise/node-core and pino loggers.
   */
  logger?: SSELogger
  /**
   * Custom serializer for SSE message data on this route.
   * Overrides the global serializer if set.
   * @default JSON.stringify
   */
  serializer?: (data: unknown) => string
  /**
   * Heartbeat interval in milliseconds for this route.
   * Overrides the global heartbeat interval if set.
   * Set to 0 to disable heartbeats.
   * @default 30000
   */
  heartbeatInterval?: number
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
    Contract['requestBody'] extends z.ZodTypeAny ? z.infer<Contract['requestBody']> : undefined
  >
  /** Optional route configuration */
  options?: FastifySSERouteOptions
}

/**
 * Maps SSE contracts to route handler containers for type checking.
 */
export type BuildFastifySSERoutesReturnType<
  APIContracts extends Record<string, AnySSEContractDefinition>,
> = {
  [K in keyof APIContracts]: SSERouteHandler<APIContracts[K]>
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
 *   connection: SSESession,
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
  Body: Contract['requestBody'] extends z.ZodTypeAny ? z.infer<Contract['requestBody']> : undefined
}>

// ============================================================================
// Dual-Mode Handler Types
// ============================================================================

/**
 * Handler function for sync (non-streaming) mode.
 * Signature matches Fastify's `(request, reply)` pattern.
 *
 * @template Params - Path parameters type
 * @template Query - Query string parameters type
 * @template Headers - Request headers type
 * @template Body - Request body type
 * @template SyncResponse - Response type that must match contract's syncResponse schema
 */
export type SyncModeHandler<
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
 * Handler function for SSE mode with deferred headers.
 *
 * The handler receives an SSEContext object that allows:
 * 1. Early returns before headers are sent (validation errors, not found, etc.)
 * 2. Explicit streaming start via `sse.start(mode)`
 * 3. Type-safe event sending via the returned session
 *
 * @returns SSEHandlerResult indicating how to handle the response:
 * - `sse.respond(code, body)`: Send HTTP response before streaming (early return)
 * - `void`: Streaming started, session mode determines lifecycle
 *
 * @example
 * ```typescript
 * // Request-response streaming (AI completions) - autoClose mode
 * sse: async (request, sse) => {
 *   const entity = await db.find(request.params.id)
 *   if (!entity) {
 *     return sse.respond(404, { error: 'Not found' })
 *   }
 *
 *   const session = sse.start('autoClose')
 *   await session.send('chunk', { delta: 'Hello' })
 *   await session.send('done', { usage: { total: 5 } })
 *   // Session closes automatically after handler returns
 * }
 *
 * // Long-lived session (notifications) - keepAlive mode
 * sse: async (request, sse) => {
 *   const session = sse.start('keepAlive')
 *   this.subscriptions.set(session.id, request.params.userId)
 *   // Session stays open after handler returns
 * }
 * ```
 *
 * @template Events - SSE event schemas for type-safe sending
 * @template Params - Path parameters type
 * @template Query - Query string parameters type
 * @template Headers - Request headers type
 * @template Body - Request body type
 */
export type SSEModeHandler<
  Events extends SSEEventSchemas = SSEEventSchemas,
  Params = unknown,
  Query = unknown,
  Headers = unknown,
  Body = unknown,
> = (
  request: FastifyRequest<{ Params: Params; Querystring: Query; Headers: Headers; Body: Body }>,
  sse: SSEContext<Events>,
) => SSEHandlerResult | Promise<SSEHandlerResult>

/**
 * Combined handlers for dual-mode routes.
 *
 * @template Params - Path parameters type
 * @template Query - Query string parameters type
 * @template Headers - Request headers type
 * @template Body - Request body type
 * @template SyncResponse - Sync response type
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
  sync: SyncModeHandler<Params, Query, Headers, Body, SyncResponse>
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
 * Infer handlers type based on contract type.
 * All dual-mode contracts use `{ sync: handler, sse: handler }` pattern.
 *
 * @template Contract - The dual-mode contract definition
 */
export type InferDualModeHandlers<Contract extends AnyDualModeContractDefinition> =
  DualModeHandlers<
    z.infer<Contract['params']>,
    z.infer<Contract['query']>,
    z.infer<Contract['requestHeaders']>,
    Contract['requestBody'] extends z.ZodTypeAny ? z.infer<Contract['requestBody']> : undefined,
    Contract['syncResponse'] extends z.ZodTypeAny ? z.infer<Contract['syncResponse']> : unknown,
    Contract['events']
  >

/**
 * Handler configuration returned by buildDualModeRoutes().
 *
 * @template Contract - The dual-mode route definition
 */
export type FastifyDualModeHandlerConfig<Contract extends AnyDualModeContractDefinition> = {
  /** The dual-mode route contract */
  contract: Contract
  /** Handlers for sync and SSE modes - type depends on contract style */
  handlers: InferDualModeHandlers<Contract>
  /** Optional route configuration */
  options?: FastifyDualModeRouteOptions
}

/**
 * Maps dual-mode contracts to route handler containers for type checking.
 */
export type BuildFastifyDualModeRoutesReturnType<
  APIContracts extends Record<string, AnyDualModeContractDefinition>,
> = {
  [K in keyof APIContracts]: DualModeRouteHandler<APIContracts[K]>
}

// ============================================================================
// Unified Handler Builder
// ============================================================================

/**
 * SSE-only handler object - just the SSE handler.
 * Explicitly rejects `sync` property to distinguish from dual-mode handlers.
 */
export type SSEOnlyHandlers<
  Events extends SSEEventSchemas = SSEEventSchemas,
  Params = unknown,
  Query = unknown,
  Headers = unknown,
  Body = unknown,
> = {
  sse: SSEModeHandler<Events, Params, Query, Headers, Body>
  /** SSE-only contracts do not support sync handlers */
  sync?: never
}

/**
 * Infer the handler type based on contract type.
 * - SSE-only contracts: `{ sse: handler }`
 * - Dual-mode contracts: `{ sync: handler, sse: handler }`
 */
export type InferHandlers<Contract> = Contract extends AnyDualModeContractDefinition
  ? InferDualModeHandlers<Contract>
  : Contract extends AnySSEContractDefinition
    ? SSEOnlyHandlers<
        Contract['events'],
        z.infer<Contract['params']>,
        z.infer<Contract['query']>,
        z.infer<Contract['requestHeaders']>,
        Contract['requestBody'] extends z.ZodTypeAny ? z.infer<Contract['requestBody']> : undefined
      >
    : never

/**
 * Helper type to infer the correct handlers type based on contract.
 */
type HandlersForContract<Contract> = Contract extends AnyDualModeContractDefinition
  ? InferDualModeHandlers<Contract>
  : Contract extends AnySSEContractDefinition
    ? SSEOnlyHandlers<
        Contract['events'],
        z.infer<Contract['params']>,
        z.infer<Contract['query']>,
        z.infer<Contract['requestHeaders']>,
        Contract['requestBody'] extends z.ZodTypeAny ? z.infer<Contract['requestBody']> : undefined
      >
    : never

// ============================================================================
// Route Handler Container Types
// ============================================================================

/**
 * Branded container for SSE route handlers.
 * Contains the contract, handlers, and optional route configuration.
 *
 * @template Contract - The SSE contract definition
 */
export type SSERouteHandler<Contract extends AnySSEContractDefinition> = {
  readonly __type: 'SSERouteHandler'
  readonly contract: Contract
  readonly handlers: SSEOnlyHandlers<
    Contract['events'],
    z.infer<Contract['params']>,
    z.infer<Contract['query']>,
    z.infer<Contract['requestHeaders']>,
    Contract['requestBody'] extends z.ZodTypeAny ? z.infer<Contract['requestBody']> : undefined
  >
  readonly options?: FastifySSERouteOptions
}

/**
 * Branded container for dual-mode route handlers.
 * Contains the contract, handlers, and optional route configuration.
 *
 * @template Contract - The dual-mode contract definition
 */
export type DualModeRouteHandler<Contract extends AnyDualModeContractDefinition> = {
  readonly __type: 'DualModeRouteHandler'
  readonly contract: Contract
  readonly handlers: InferDualModeHandlers<Contract>
  readonly options?: FastifyDualModeRouteOptions
}

/**
 * Unified handler builder for both SSE-only and dual-mode contracts.
 *
 * Returns a branded container with the contract embedded, eliminating the need
 * to pass the contract separately when building routes.
 *
 * This function provides automatic type inference based on the contract type:
 * - **SSE-only contracts**: Provide `{ sse: handler }` only
 * - **Dual-mode contracts**: Provide both `{ sync: handler, sse: handler }`
 *
 * ## Handler Signatures
 *
 * **Sync handler** (dual-mode only):
 * ```typescript
 * sync: (request, reply) => SyncResponse | Promise<SyncResponse>
 * ```
 *
 * **SSE handler** (both SSE-only and dual-mode):
 * ```typescript
 * sse: (request, sse) => SSEHandlerResult | Promise<SSEHandlerResult>
 * ```
 *
 * The SSE handler receives an SSEContext that allows deferred header sending:
 * - `sse.respond(code, body)` - Return HTTP response before streaming (early return)
 * - `sse.start(mode)` - Start streaming (sends 200 + SSE headers), returns session
 *   - `'autoClose'` - Close session after handler completes
 *   - `'keepAlive'` - Keep session open for external events
 *
 * @see SSEContext for the sse parameter API
 * @see SSEHandlerResult for the possible return values
 *
 * @example
 * ```typescript
 * // SSE-only contract - request-response streaming with early return
 * const sseHandler = buildHandler(chatStreamContract, {
 *   sse: async (request, sse) => {
 *     const entity = await db.find(request.params.id)
 *     if (!entity) {
 *       return sse.respond(404, { error: 'Not found' })
 *     }
 *     const session = sse.start('autoClose')
 *     for (const word of request.body.message.split(' ')) {
 *       await session.send('chunk', { delta: word })
 *     }
 *     await session.send('done', { usage: { total: 5 } })
 *   },
 * })
 *
 * // SSE-only with options (3rd param)
 * const notificationHandler = buildHandler(notificationsContract, {
 *   sse: async (request, sse) => {
 *     const session = sse.start('keepAlive')
 *     this.subscriptions.set(session.id, request.params.userId)
 *   },
 * }, { onConnect: ..., onClose: ... })
 *
 * // Dual-mode contract - supports both sync and SSE responses
 * const dualModeHandler = buildHandler(chatCompletionContract, {
 *   sync: (request, reply) => {
 *     reply.header('x-custom', 'value')
 *     return { reply: 'Hello', usage: { tokens: 5 } }
 *   },
 *   sse: async (request, sse) => {
 *     const session = sse.start('autoClose')
 *     await session.send('chunk', { delta: 'Hello' })
 *     await session.send('done', { usage: { total: 5 } })
 *   },
 * }, { preHandler: authHandler })
 * ```
 */
export function buildHandler<Contract extends AnySSEContractDefinition>(
  contract: Contract,
  handlers: HandlersForContract<Contract>,
  options?: FastifySSERouteOptions,
): SSERouteHandler<Contract>

export function buildHandler<Contract extends AnyDualModeContractDefinition>(
  contract: Contract,
  handlers: HandlersForContract<Contract>,
  options?: FastifyDualModeRouteOptions,
): DualModeRouteHandler<Contract>

export function buildHandler<
  Contract extends AnyDualModeContractDefinition | AnySSEContractDefinition,
>(
  contract: Contract,
  handlers: HandlersForContract<Contract>,
  options?: FastifySSERouteOptions | FastifyDualModeRouteOptions,
): SSERouteHandler<AnySSEContractDefinition> | DualModeRouteHandler<AnyDualModeContractDefinition> {
  // Check if this is a dual-mode contract (has syncResponse or isDualMode marker)
  if ('isDualMode' in contract && contract.isDualMode) {
    return {
      __type: 'DualModeRouteHandler',
      contract: contract as AnyDualModeContractDefinition,
      handlers: handlers as InferDualModeHandlers<AnyDualModeContractDefinition>,
      options: options as FastifyDualModeRouteOptions,
    }
  }

  // SSE-only contract
  return {
    __type: 'SSERouteHandler',
    contract: contract as AnySSEContractDefinition,
    handlers: handlers as SSEOnlyHandlers,
    options: options as FastifySSERouteOptions,
  }
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
