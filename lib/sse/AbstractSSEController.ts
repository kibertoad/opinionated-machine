import type { SSEReplyInterface } from '@fastify/sse'
import { InternalError } from '@lokalise/node-core'
import type { FastifyReply } from 'fastify'
import type { z } from 'zod'
import type { BuildFastifySSERoutesReturnType, SSEConnection } from '../routes/fastifyRouteTypes.ts'
import { SSEConnectionSpy } from './SSEConnectionSpy.ts'
import type { AnySSEContractDefinition } from './sseContracts.ts'
import type {
  AllContractEventNames,
  ExtractEventSchema,
  SSEControllerConfig,
  SSEMessage,
} from './sseTypes.ts'

// Re-export Fastify-specific types
export type {
  BuildFastifySSERoutesReturnType,
  FastifySSEHandlerConfig,
  FastifySSEPreHandler,
  FastifySSERouteOptions,
  InferSSERequest,
  SSEConnection,
} from '../routes/fastifyRouteTypes.ts'
// Re-export types for backwards compatibility
export type { SSEConnectionEvent } from './SSEConnectionSpy.ts'
export { SSEConnectionSpy } from './SSEConnectionSpy.ts'
// Re-export framework-agnostic types
export type {
  AllContractEventNames,
  AllContractEvents,
  ExtractEventSchema,
  SSEControllerConfig,
  SSEEventSchemas,
  SSEEventSender,
  SSELogger,
  SSEMessage,
} from './sseTypes.ts'

/**
 * FastifyReply extended with SSE capabilities from @fastify/sse.
 */
type SSEReply = FastifyReply & { sse: SSEReplyInterface }

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
 *     notifications: buildContract({ ... }),
 *   } as const
 *
 *   public buildSSERoutes() {
 *     return {
 *       notifications: {
 *         contract: NotificationsSSEController.contracts.notifications,
 *         handlers: buildHandler(NotificationsSSEController.contracts.notifications, {
 *           sse: async (request, connection) => {
 *             await connection.send('notification', { message: 'Hello!' })
 *           },
 *         }),
 *       },
 *     }
 *   }
 * }
 * ```
 */
export abstract class AbstractSSEController<
  APIContracts extends Record<string, AnySSEContractDefinition>,
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
   * // Pass dependencies first, then config with enableConnectionSpy
   * const controller = new MySSEController({}, { enableConnectionSpy: true })
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
  public abstract buildSSERoutes(): BuildFastifySSERoutesReturnType<APIContracts>

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
   * This is a private method used internally by broadcast methods and sendEventInternal.
   * Handlers should use the type-safe `connection.send` method instead of calling
   * this method directly.
   *
   * Event data is validated against the Zod schema defined in the contract's `events` field
   * if the connection has event schemas attached (which happens automatically when routes
   * are built using buildFastifyRoute).
   *
   * @param connectionId - The connection to send to
   * @param message - The SSE message to send
   * @returns true if sent successfully, false if connection not found or closed
   * @throws Error if event data fails validation against the contract schema
   */
  private async sendEvent<T>(connectionId: string, message: SSEMessage<T>): Promise<boolean> {
    const connection = this.connections.get(connectionId)
    if (!connection) {
      return false
    }

    // Validate event data against schema if available
    if (message.event && connection.eventSchemas) {
      const schema = connection.eventSchemas[message.event]
      if (schema) {
        const result = schema.safeParse(message.data)
        if (!result.success) {
          throw new InternalError({
            message: `SSE event validation failed for event "${message.event}": ${result.error.message}`,
            errorCode: 'RESPONSE_VALIDATION_FAILED',
          })
        }
      }
    }

    try {
      const reply = connection.reply as SSEReply
      // @fastify/sse serializes data (JSON by default, customizable via plugin config)
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
      // Use unregisterConnection to ensure hooks and spy are notified
      this.unregisterConnection(connectionId)
      return false
    }
  }

  /**
   * Raw internal method for the route builder to send events.
   * This is used by the route builder to create the typed `send` function.
   * External code should use `sendEventInternal` instead for type safety.
   * @internal
   */
  public _sendEventRaw<T>(connectionId: string, message: SSEMessage<T>): Promise<boolean> {
    return this.sendEvent(connectionId, message)
  }

  /**
   * Send an event to a connection with type-safe event names and data.
   *
   * This method provides autocomplete and type checking for event names and data
   * that match any event defined in the controller's contracts. Use this for
   * external event sources (subscriptions, timers, message queues) when you
   * don't have access to the handler's `send` function.
   *
   * For best type safety in handlers, use the `send` parameter instead.
   * For external sources, you can also store the `send` function for per-route typing.
   *
   * @example
   * ```typescript
   * // External event source (subscription callback)
   * this.messageQueue.onMessage((msg) => {
   *   this.sendEventInternal(connectionId, {
   *     event: 'notification',  // autocomplete shows all valid events
   *     data: { id: msg.id, message: msg.text }  // typed based on event
   *   })
   * })
   * ```
   *
   * @param connectionId - The connection to send to
   * @param message - The event message with typed event name and data
   * @returns true if sent successfully, false if connection not found
   */
  public sendEventInternal<EventName extends AllContractEventNames<APIContracts>>(
    connectionId: string,
    message: {
      event: EventName
      data: z.input<ExtractEventSchema<APIContracts, EventName>>
      id?: string
      retry?: number
    },
  ): Promise<boolean> {
    return this.sendEvent(connectionId, message)
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
   * This gracefully ends the SSE stream by calling the underlying `reply.sse.close()`.
   * All previously sent data is flushed to the client before the connection terminates.
   * Use this to signal end-of-stream after sending all events (e.g., in request-response
   * style streaming like OpenAI completions).
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

    // Use unregisterConnection to ensure hooks and spy are notified
    this.unregisterConnection(connectionId)
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
   * This method is idempotent - calling it multiple times for the same
   * connection ID has no effect after the first call.
   * @internal
   */
  public unregisterConnection(connectionId: string): void {
    const connection = this.connections.get(connectionId)
    if (!connection) {
      // Already unregistered or never existed - do nothing (idempotent)
      return
    }
    this.onConnectionClosed?.(connection)
    // Notify spy of disconnection
    this._connectionSpy?.addDisconnection(connectionId)
    this.connections.delete(connectionId)
  }
}
