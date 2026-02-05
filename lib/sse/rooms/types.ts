import type { SSEMessage } from '../sseTypes.js'

/**
 * Options for broadcasting to rooms.
 */
export type RoomBroadcastOptions = {
  /**
   * Only broadcast locally (skip adapter propagation to other nodes).
   * Useful for testing or node-specific announcements.
   * @default false
   */
  local?: boolean
}

/**
 * Adapter interface for cross-node room communication.
 *
 * Adapters handle the propagation of room broadcasts across multiple server nodes.
 * The default InMemoryAdapter is a no-op for single-node deployments.
 * For multi-node deployments, use RedisAdapter or implement a custom adapter.
 */
export type SSERoomAdapter = {
  /**
   * Connect to the underlying messaging system (e.g., Redis).
   * Called when the room manager is initialized.
   */
  connect(): Promise<void>

  /**
   * Disconnect from the underlying messaging system.
   * Called during graceful shutdown.
   */
  disconnect(): Promise<void>

  /**
   * Subscribe to messages for a specific room.
   * Called when any connection on this node joins a room.
   *
   * @param room - The room to subscribe to
   */
  subscribe(room: string): Promise<void>

  /**
   * Unsubscribe from messages for a specific room.
   * Called when no connections on this node are in a room anymore.
   *
   * @param room - The room to unsubscribe from
   */
  unsubscribe(room: string): Promise<void>

  /**
   * Publish a message to all nodes subscribed to a room.
   * The message will be received by all nodes (including sender) via onMessage.
   *
   * @param room - The room to publish to
   * @param message - The SSE message to broadcast
   */
  publish(room: string, message: SSEMessage): Promise<void>

  /**
   * Register a handler for messages received from other nodes.
   * The handler should forward the message to local connections in the room.
   *
   * @param handler - Callback invoked when a message is received
   */
  onMessage(handler: SSERoomMessageHandler): void
}

/**
 * Handler for messages received from the adapter (other nodes).
 */
export type SSERoomMessageHandler = (
  room: string,
  message: SSEMessage,
  sourceNodeId: string,
) => void

/**
 * Configuration for the SSE Room Manager.
 */
export type SSERoomManagerConfig = {
  /**
   * Optional adapter for cross-node communication.
   * If not provided, uses InMemoryAdapter (single-node only).
   */
  adapter?: SSERoomAdapter

  /**
   * Unique identifier for this server node.
   * Used to prevent echo when receiving messages from the adapter.
   * @default crypto.randomUUID()
   */
  nodeId?: string
}

/**
 * Room operations available on SSE sessions.
 * Accessed via `session.rooms.join()`, `session.rooms.leave()`.
 */
export type SSERoomOperations = {
  /**
   * Join one or more rooms.
   *
   * @param room - Room name or array of room names to join
   *
   * @example
   * ```typescript
   * // Join a single room based on route parameter
   * session.rooms.join(`dashboard:${request.params.dashboardId}`)
   *
   * // Join multiple rooms
   * session.rooms.join(['project:123', 'team:engineering'])
   * ```
   */
  join: (room: string | string[]) => void

  /**
   * Leave one or more rooms.
   *
   * @param room - Room name or array of room names to leave
   */
  leave: (room: string | string[]) => void
}
