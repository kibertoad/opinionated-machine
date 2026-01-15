import type { SSEReplyInterface } from '@fastify/sse'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { z } from 'zod'
import { SSEConnectionSpy } from './SSEConnectionSpy.ts'
import type { AnySSERouteDefinition } from './sseContracts.ts'

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
export type SSEPreHandler = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<FastifyReply | void>

/**
 * FastifyReply extended with SSE capabilities from @fastify/sse.
 */
type SSEReply = FastifyReply & { sse: SSEReplyInterface }

export { type SSEConnectionEvent, SSEConnectionSpy } from './SSEConnectionSpy.ts'

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
   * Return an async iterable of events to replay, or handle replay manually.
   */
  onReconnect?: (
    connection: SSEConnection,
    lastEventId: string,
  ) => AsyncIterable<SSEMessage> | void | Promise<void>
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
 * Abstract base class for SSE controllers.
 *
 * Provides connection management, broadcasting, and lifecycle hooks.
 * Extend this class to create SSE controllers that handle real-time
 * streaming connections.
 *
 * @template APIContracts - Map of route names to SSE route definitions
 *
 * @example
 * ```typescript
 * class NotificationsSSEController extends AbstractSSEController<typeof contracts> {
 *   public static contracts = {
 *     notifications: buildSSERoute({ ... }),
 *   } as const
 *
 *   public buildSSERoutes() {
 *     return {
 *       notifications: {
 *         contract: NotificationsSSEController.contracts.notifications,
 *         handler: this.handleNotifications,
 *       },
 *     }
 *   }
 * }
 * ```
 */

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

export abstract class AbstractSSEController<
  APIContracts extends Record<string, AnySSERouteDefinition>,
> {
  /** Map of connection ID to connection object */
  protected connections: Map<string, SSEConnection> = new Map()

  /** Private storage for connection spy */
  private readonly _connectionSpy?: SSEConnectionSpy

  /**
   * SSE controllers must override this constructor and call super with their
   * dependencies object and the SSE config.
   *
   * @param _dependencies - The dependencies object (cradle proxy in awilix)
   * @param sseConfig - Optional SSE controller configuration
   *
   * @example
   * ```typescript
   * class MySSEController extends AbstractSSEController<MyContracts> {
   *   private myService: MyService
   *
   *   constructor(deps: { myService: MyService }, sseConfig?: SSEControllerConfig) {
   *     super(deps, sseConfig)
   *     this.myService = deps.myService
   *   }
   * }
   * ```
   */
  constructor(_dependencies: object, sseConfig?: SSEControllerConfig) {
    if (sseConfig?.enableConnectionSpy) {
      this._connectionSpy = new SSEConnectionSpy()
    }
  }

  /**
   * Get the connection spy for testing.
   * Throws an error if spies are not enabled.
   * Enable spies by passing `{ enableConnectionSpy: true }` to the constructor.
   *
   * @example
   * ```typescript
   * // In test, create controller with spy enabled
   * const controller = new MySSEController({ enableConnectionSpy: true })
   *
   * // Start connection (async)
   * connectSSE(baseUrl, '/api/stream')
   *
   * // Wait for connection - handles race condition
   * const connection = await controller.connectionSpy.waitForConnection()
   * ```
   *
   * @throws Error if connection spy is not enabled
   */
  public get connectionSpy(): SSEConnectionSpy {
    if (!this._connectionSpy) {
      throw new Error(
        'Connection spy is not enabled. Pass { enableConnectionSpy: true } to the constructor. ' +
          'This should only be used in test environments.',
      )
    }
    return this._connectionSpy
  }

  /**
   * Build and return SSE route configurations.
   * Similar pattern to AbstractController.buildRoutes().
   */
  public abstract buildSSERoutes(): BuildSSERoutesReturnType<APIContracts>

  /**
   * Controller-level hook called when any connection is established.
   * Override this method to add global connection handling logic.
   * This is called AFTER the connection is registered and route-level onConnect.
   *
   * @param connection - The newly established connection
   */
  protected onConnectionEstablished?(connection: SSEConnection): void

  /**
   * Controller-level hook called when any connection is closed.
   * Override this method to add global disconnect handling logic.
   * This is called BEFORE the connection is unregistered and route-level onDisconnect.
   *
   * @param connection - The connection being closed
   */
  protected onConnectionClosed?(connection: SSEConnection): void

  /**
   * Send an event to a specific connection.
   *
   * @param connectionId - The connection to send to
   * @param message - The SSE message to send
   * @returns true if sent successfully, false if connection not found or closed
   */
  protected async sendEvent<T>(connectionId: string, message: SSEMessage<T>): Promise<boolean> {
    const connection = this.connections.get(connectionId)
    if (!connection) {
      return false
    }

    try {
      const reply = connection.reply as SSEReply
      // @fastify/sse handles JSON serialization internally, so pass data as-is
      await reply.sse.send({
        data: message.data,
        event: message.event,
        id: message.id,
        retry: message.retry,
      })
      return true
    } catch {
      // Send failed - connection is likely closed (client disconnected, network error, etc.)
      // Remove from tracking to prevent further send attempts to a dead connection
      this.connections.delete(connectionId)
      return false
    }
  }

  /**
   * Broadcast an event to all connected clients.
   *
   * @param message - The SSE message to broadcast
   * @returns Number of clients the message was sent to
   */
  protected async broadcast<T>(message: SSEMessage<T>): Promise<number> {
    let sent = 0
    const connectionIds = Array.from(this.connections.keys())
    for (const id of connectionIds) {
      if (await this.sendEvent(id, message)) {
        sent++
      }
    }
    return sent
  }

  /**
   * Broadcast an event to connections matching a predicate.
   *
   * @param message - The SSE message to broadcast
   * @param predicate - Function to filter connections
   * @returns Number of clients the message was sent to
   */
  protected async broadcastIf<T>(
    message: SSEMessage<T>,
    predicate: (connection: SSEConnection) => boolean,
  ): Promise<number> {
    let sent = 0
    for (const [id, connection] of this.connections) {
      if (predicate(connection) && (await this.sendEvent(id, message))) {
        sent++
      }
    }
    return sent
  }

  /**
   * Get all active connections.
   */
  protected getConnections(): SSEConnection[] {
    return Array.from(this.connections.values())
  }

  /**
   * Get the number of active connections.
   */
  protected getConnectionCount(): number {
    return this.connections.size
  }

  /**
   * Close a specific connection.
   *
   * @param connectionId - The connection to close
   * @returns true if connection was found and closed
   */
  protected closeConnection(connectionId: string): boolean {
    const connection = this.connections.get(connectionId)
    if (!connection) {
      return false
    }

    try {
      const reply = connection.reply as SSEReply
      reply.sse.close()
    } catch {
      // Connection may already be closed
    }

    this.connections.delete(connectionId)
    return true
  }

  /**
   * Close all active connections.
   * Called during graceful shutdown via asyncDispose.
   */
  public closeAllConnections(): void {
    const connectionIds = Array.from(this.connections.keys())
    for (const id of connectionIds) {
      this.closeConnection(id)
    }
  }

  /**
   * Register a connection (called internally by route builder).
   * Triggers the onConnectionEstablished hook and spy if defined.
   * @internal
   */
  public registerConnection(connection: SSEConnection): void {
    this.connections.set(connection.id, connection)
    this.onConnectionEstablished?.(connection)
    // Notify spy after hook (so hook can set context before spy sees it)
    this._connectionSpy?.addConnection(connection)
  }

  /**
   * Unregister a connection (called internally by route builder).
   * Triggers the onConnectionClosed hook and spy if defined.
   * @internal
   */
  public unregisterConnection(connectionId: string): void {
    const connection = this.connections.get(connectionId)
    if (connection) {
      this.onConnectionClosed?.(connection)
    }
    // Notify spy of disconnection
    this._connectionSpy?.addDisconnection(connectionId)
    this.connections.delete(connectionId)
  }
}
