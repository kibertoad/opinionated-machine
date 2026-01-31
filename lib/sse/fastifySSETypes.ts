import type { FastifyReply, FastifyRequest } from 'fastify'
import type { z } from 'zod'
import type { AnySSEContractDefinition } from './sseContracts.ts'
import type { SSEEventSchemas, SSEEventSender, SSELogger, SSEMessage } from './sseTypes.ts'

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
