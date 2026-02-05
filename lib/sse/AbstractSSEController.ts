import { randomUUID } from 'node:crypto'
import type { SSEReplyInterface } from '@fastify/sse'
import type {
  AllContractEventNames,
  AnySSEContractDefinition,
  ExtractEventSchema,
} from '@lokalise/api-contracts'
import { InternalError } from '@lokalise/node-core'
import type { FastifyReply } from 'fastify'
import type { z } from 'zod'
import type { BuildFastifySSERoutesReturnType, SSESession } from '../routes/fastifyRouteTypes.ts'
import { SSERoomManager } from './rooms/SSERoomManager.ts'
import type { RoomBroadcastOptions } from './rooms/types.ts'
import { SSESessionSpy } from './SSESessionSpy.ts'
import type { SSEControllerConfig, SSEMessage } from './sseTypes.ts'

// Re-export Fastify-specific types
export type {
  BuildFastifySSERoutesReturnType,
  FastifySSEHandlerConfig,
  FastifySSEPreHandler,
  FastifySSERouteOptions,
  InferSSERequest,
  SSEContext,
  SSEHandlerResult,
  SSERespondResult,
  SSESession,
  SSESessionMode,
  SSEStartOptions,
} from '../routes/fastifyRouteTypes.ts'
// Re-export types for backwards compatibility
export type { SSESessionEvent } from './SSESessionSpy.ts'
export { SSESessionSpy } from './SSESessionSpy.ts'
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
 *     notifications: buildSseContract({ ... }),
 *   } as const
 *
 *   public buildSSERoutes() {
 *     return {
 *       notifications: this.handleNotifications,
 *     }
 *   }
 *
 *   private handleNotifications = buildHandler(
 *     NotificationsSSEController.contracts.notifications,
 *     {
 *       sse: async (request, sse) => {
 *         const session = sse.start('autoClose')
 *         await session.send('notification', { message: 'Hello!' })
 *         // Connection closes automatically when handler returns
 *       },
 *     },
 *   )
 * }
 * ```
 */
export abstract class AbstractSSEController<
  APIContracts extends Record<string, AnySSEContractDefinition>,
> {
  /** Map of connection ID to connection object */
  protected connections: Map<string, SSESession> = new Map()

  /** Private storage for connection spy */
  private readonly _connectionSpy?: SSESessionSpy

  /** Room manager for room-based broadcasting (optional) */
  private readonly _roomManager?: SSERoomManager

  /** Maximum number of message IDs to cache per connection for deduplication */
  private static readonly MAX_DEDUP_CACHE_SIZE = 1000

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
      this._connectionSpy = new SSESessionSpy()
    }

    if (sseConfig?.rooms) {
      this._roomManager = new SSERoomManager(sseConfig.rooms)

      // Wire up adapter message handler to forward to local connections
      this._roomManager.onRemoteMessage((room, message, _sourceNodeId) => {
        return this.handleRemoteBroadcast(room, message)
      })
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
  public get connectionSpy(): SSESessionSpy {
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
  protected onConnectionEstablished?(connection: SSESession): void

  /**
   * Controller-level hook called when any connection is closed.
   * Override this method to add global disconnect handling logic.
   * This is called BEFORE the connection is unregistered and route-level onClose.
   *
   * @param connection - The connection being closed
   */
  protected onConnectionClosed?(connection: SSESession): void

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
   * Get the room manager for use by route utilities.
   * Returns undefined if rooms are not enabled.
   * @internal
   */
  public get _internalRoomManager(): SSERoomManager | undefined {
    return this._roomManager
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
    predicate: (connection: SSESession) => boolean,
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
  protected getConnections(): SSESession[] {
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
   *
   * Called automatically by the route builder when handler returns `success('disconnect')`.
   * Can also be called manually for scenarios like external triggers or timeouts.
   *
   * @param connectionId - The connection to close
   * @returns true if connection was found and closed
   */
  public closeConnection(connectionId: string): boolean {
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
  public registerConnection(connection: SSESession): void {
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

    // Auto-leave all rooms on disconnect
    this._roomManager?.leaveAll(connectionId)

    this.connections.delete(connectionId)
  }

  // ============================================================================
  // Room Operations
  // ============================================================================

  /**
   * Get the room manager for this controller.
   * Throws an error if rooms are not enabled.
   *
   * @throws Error if rooms are not enabled in the controller config
   */
  protected get roomManager(): SSERoomManager {
    if (!this._roomManager) {
      throw new Error(
        'Rooms are not enabled. Pass { rooms: {} } to the controller config to enable rooms.',
      )
    }
    return this._roomManager
  }

  /**
   * Check if rooms are enabled for this controller.
   */
  protected get roomsEnabled(): boolean {
    return this._roomManager !== undefined
  }

  /**
   * Broadcast a type-safe event to all connections in one or more rooms.
   *
   * Event names and data are validated against the controller's contract schemas
   * at compile time, ensuring only valid events can be broadcast.
   *
   * When broadcasting to multiple rooms, connections in multiple rooms
   * only receive the message once (de-duplicated).
   *
   * @param room - Room name or array of room names
   * @param eventName - Event name (must be defined in one of the controller's contracts)
   * @param data - Event data (must match the schema for the event)
   * @param options - Broadcast options (local, id, retry)
   * @returns Number of local connections the message was sent to
   *
   * @example
   * ```typescript
   * // Broadcast to a single room (type-safe)
   * await this.broadcastToRoom('dashboard:123', 'metricsUpdate', {
   *   cpu: 45.2, memory: 72.1
   * })
   *
   * // Broadcast to multiple rooms (no duplicates)
   * await this.broadcastToRoom(['premium', 'beta-testers'], 'featureFlag', {
   *   flag: 'new-ui', enabled: true
   * })
   * ```
   */
  protected async broadcastToRoom<EventName extends AllContractEventNames<APIContracts>>(
    room: string | string[],
    eventName: EventName,
    data: ExtractEventSchema<APIContracts, EventName> extends z.ZodTypeAny
      ? z.input<ExtractEventSchema<APIContracts, EventName>>
      : never,
    options?: RoomBroadcastOptions & { id?: string; retry?: number },
  ): Promise<number> {
    if (!this._roomManager) {
      return 0
    }

    // Generate a stable message ID for deduplication if not provided
    const messageId = options?.id ?? randomUUID()

    const message: SSEMessage = {
      event: eventName,
      data,
      id: messageId,
      retry: options?.retry,
    }

    const rooms = Array.isArray(room) ? room : [room]
    const connectionIds = this.collectRoomConnections(this._roomManager, rooms)

    // Send to all local connections
    let sent = 0
    for (const connId of connectionIds) {
      if (await this.sendEvent(connId, message)) {
        sent++
      }
    }

    // Publish to adapter for cross-node propagation (unless local-only)
    // Only publish once with all rooms - adapter handles per-room delivery
    if (!options?.local) {
      for (const r of rooms) {
        await this._roomManager.publish(r, message, options)
      }
    }

    return sent
  }

  /**
   * Collect unique connection IDs from multiple rooms.
   */
  private collectRoomConnections(roomManager: SSERoomManager, rooms: string[]): Set<string> {
    const connectionIds = new Set<string>()
    for (const r of rooms) {
      for (const connId of roomManager.getConnectionsInRoom(r)) {
        connectionIds.add(connId)
      }
    }
    return connectionIds
  }

  /**
   * Check if a message has already been delivered to a connection (deduplication).
   * Returns true if the message is a duplicate and should be skipped.
   * @internal
   */
  private isDuplicateMessage(connection: SSESession, messageId: string | undefined): boolean {
    if (!messageId) {
      return false
    }

    // Initialize the dedup cache if needed
    if (!connection.recentMessageIds) {
      connection.recentMessageIds = new Set()
    }

    if (connection.recentMessageIds.has(messageId)) {
      return true // Already delivered to this connection
    }

    // FIFO eviction: remove oldest entry if at capacity
    if (connection.recentMessageIds.size >= AbstractSSEController.MAX_DEDUP_CACHE_SIZE) {
      const oldest = connection.recentMessageIds.values().next().value as string
      connection.recentMessageIds.delete(oldest)
    }

    connection.recentMessageIds.add(messageId)
    return false
  }

  /**
   * Handle broadcasts from other nodes (via adapter).
   * This method is called when the adapter receives a message from another node.
   * Deduplicates messages per-connection based on message ID to prevent duplicate
   * delivery when a connection is in multiple rooms that all receive the same broadcast.
   * @internal
   */
  private async handleRemoteBroadcast(room: string, message: SSEMessage): Promise<void> {
    if (!this._roomManager) {
      return
    }

    const connectionIds = this._roomManager.getConnectionsInRoom(room)
    for (const connId of connectionIds) {
      const connection = this.connections.get(connId)
      if (!connection) {
        continue
      }

      // Per-connection deduplication - skip if already delivered
      if (this.isDuplicateMessage(connection, message.id)) {
        continue
      }

      await this.sendEvent(connId, message)
    }
  }

  /**
   * Join a connection to one or more rooms.
   * Prefer using `session.rooms.join()` in handlers instead.
   *
   * @param connectionId - The connection to add to rooms
   * @param room - Room name or array of room names
   */
  protected joinRoom(connectionId: string, room: string | string[]): void {
    this._roomManager?.join(connectionId, room)
  }

  /**
   * Remove a connection from one or more rooms.
   * Prefer using `session.rooms.leave()` in handlers instead.
   *
   * @param connectionId - The connection to remove from rooms
   * @param room - Room name or array of room names
   */
  protected leaveRoom(connectionId: string, room: string | string[]): void {
    this._roomManager?.leave(connectionId, room)
  }

  /**
   * Get all connection IDs in a room.
   *
   * @param room - The room to query
   * @returns Array of connection IDs
   */
  protected getConnectionsInRoom(room: string): string[] {
    return this._roomManager?.getConnectionsInRoom(room) ?? []
  }

  /**
   * Get the number of connections in a room.
   *
   * @param room - The room to query
   * @returns Number of connections
   */
  protected getConnectionCountInRoom(room: string): number {
    return this._roomManager?.getConnectionCountInRoom(room) ?? 0
  }
}
