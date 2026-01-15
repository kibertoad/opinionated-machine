import type { FastifyReply, FastifyRequest } from 'fastify'
import type { z } from 'zod'
import type { AnySSERouteDefinition } from './sseContracts.ts'

/**
 * Minimal logger interface for SSE route error handling.
 * Compatible with CommonLogger from @lokalise/node-core and pino loggers.
 */
export type SSELogger = {
  error: (obj: Record<string, unknown>, msg: string) => void
}

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
export type SSEPreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>

/**
 * Represents an active SSE connection with typed context.
 *
 * @template Context - Custom context data stored per connection
 */
export type SSEConnection<Context = unknown> = {
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
}

/**
 * SSE message format compatible with @fastify/sse.
 *
 * @template T - Type of the event data
 */
export type SSEMessage<T = unknown> = {
  /** Event name (maps to EventSource 'event' field) */
  event?: string
  /** Event data (will be JSON serialized) */
  data: T
  /** Event ID for client reconnection via Last-Event-ID */
  id?: string
  /** Reconnection delay hint in milliseconds */
  retry?: number
}

/**
 * Handler called when an SSE connection is established.
 *
 * @template Params - Path parameters type
 * @template Query - Query string parameters type
 * @template Headers - Request headers type
 * @template Body - Request body type (for POST/PUT/PATCH)
 * @template Context - Connection context type
 */
export type SSERouteHandler<
  Params = unknown,
  Query = unknown,
  Headers = unknown,
  Body = unknown,
  Context = unknown,
> = (
  request: FastifyRequest<{ Params: Params; Querystring: Query; Headers: Headers; Body: Body }>,
  connection: SSEConnection<Context>,
) => void | Promise<void>

/**
 * Options for configuring an SSE route.
 */
export type SSERouteOptions = {
  /**
   * Async preHandler hook for authentication/authorization.
   * Runs BEFORE the SSE connection is established.
   *
   * MUST return a Promise - synchronous handlers will cause connection issues.
   * Return `reply.code(401).send(...)` for rejection, or `Promise.resolve()` for success.
   *
   * @see SSEPreHandler for usage examples
   */
  preHandler?: SSEPreHandler
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
export type SSEHandlerConfig<Contract extends AnySSERouteDefinition> = {
  /** The SSE route contract */
  contract: Contract
  /** Handler called when connection is established */
  handler: SSERouteHandler<
    z.infer<Contract['params']>,
    z.infer<Contract['query']>,
    z.infer<Contract['requestHeaders']>,
    Contract['body'] extends z.ZodTypeAny ? z.infer<Contract['body']> : undefined,
    unknown
  >
  /** Optional route configuration */
  options?: SSERouteOptions
}

/**
 * Maps SSE contracts to handler configurations for type checking.
 */
export type BuildSSERoutesReturnType<APIContracts extends Record<string, AnySSERouteDefinition>> = {
  [K in keyof APIContracts]: SSEHandlerConfig<APIContracts[K]>
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
export type InferSSERequest<Contract extends AnySSERouteDefinition> = FastifyRequest<{
  Params: z.infer<Contract['params']>
  Querystring: z.infer<Contract['query']>
  Headers: z.infer<Contract['requestHeaders']>
  Body: Contract['body'] extends z.ZodTypeAny ? z.infer<Contract['body']> : undefined
}>

/**
 * Configuration options for SSE controllers.
 */
export type SSEControllerConfig = {
  /**
   * Enable connection spying for testing.
   * When enabled, the controller tracks connections and allows waiting for them.
   * Only enable this in test environments.
   * @default false
   */
  enableConnectionSpy?: boolean
}
