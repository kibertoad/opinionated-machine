import { randomUUID } from 'node:crypto'
import type { SSEMessage } from '../sseTypes.ts'
import { InMemoryAdapter } from './adapters/InMemoryAdapter.ts'
import type {
  RoomBroadcastOptions,
  SSERoomAdapter,
  SSERoomManagerConfig,
  SSERoomMessageHandler,
} from './types.ts'

/**
 * Manages room membership for SSE connections.
 *
 * Provides Socket.IO-style room support for SSE connections with optional
 * cross-node propagation via adapters (e.g., Redis).
 *
 * **Data Structures (per node):**
 * - `connectionRooms: Map<ConnectionId, Set<RoomId>>` - tracks which rooms each connection is in
 * - `roomConnections: Map<RoomId, Set<ConnectionId>>` - tracks which connections are in each room
 *
 * @example Basic usage (single node)
 * ```typescript
 * const roomManager = new SSERoomManager()
 *
 * // Join rooms
 * roomManager.join(connectionId, 'announcements')
 * roomManager.join(connectionId, ['project:123', 'team:eng'])
 *
 * // Query rooms
 * roomManager.getRooms(connectionId)        // ['announcements', 'project:123', 'team:eng']
 * roomManager.getConnectionsInRoom('team:eng')  // [connectionId, ...]
 *
 * // Leave rooms
 * roomManager.leave(connectionId, 'project:123')
 * roomManager.leaveAll(connectionId)        // Called automatically on disconnect
 * ```
 *
 * @example With Redis adapter (multi-node)
 * ```typescript
 * import { RedisAdapter } from '@opinionated-machine/sse-rooms-redis'
 *
 * const roomManager = new SSERoomManager({
 *   adapter: new RedisAdapter({ pubClient, subClient })
 * })
 * ```
 */
export class SSERoomManager {
  /** Map of connection ID to set of room names */
  private readonly connectionRooms: Map<string, Set<string>> = new Map()

  /** Map of room name to set of connection IDs */
  private readonly roomConnections: Map<string, Set<string>> = new Map()

  /** Adapter for cross-node communication */
  readonly adapter: SSERoomAdapter

  /** Unique identifier for this node */
  readonly nodeId: string

  /** Handler for remote messages from adapter */
  private messageHandler?: SSERoomMessageHandler

  constructor(config: SSERoomManagerConfig = {}) {
    this.adapter = config.adapter ?? new InMemoryAdapter()
    this.nodeId = config.nodeId ?? randomUUID()

    // Set up adapter message handler
    this.adapter.onMessage((room, message, sourceNodeId, except) => {
      // Skip messages from this node (we already handled them locally)
      if (sourceNodeId === this.nodeId) {
        return
      }
      this.messageHandler?.(room, message, sourceNodeId, except)
    })
  }

  /**
   * Connect the adapter (if applicable).
   * Call this during server startup.
   */
  async connect(): Promise<void> {
    await this.adapter.connect()
  }

  /**
   * Disconnect the adapter (if applicable).
   * Call this during graceful shutdown.
   */
  async disconnect(): Promise<void> {
    await this.adapter.disconnect()
  }

  /**
   * Register a handler for messages from other nodes.
   * The controller uses this to forward messages to local connections.
   *
   * @param handler - Callback invoked when a remote message is received
   */
  onRemoteMessage(handler: SSERoomMessageHandler): void {
    this.messageHandler = handler
  }

  /**
   * Join one or more rooms.
   *
   * @param connectionId - The connection to add to rooms
   * @param room - Room name or array of room names
   */
  join(connectionId: string, room: string | string[]): void {
    const rooms = Array.isArray(room) ? room : [room]

    for (const r of rooms) {
      // Get or create connection's room set
      let connRooms = this.connectionRooms.get(connectionId)
      if (!connRooms) {
        connRooms = new Set()
        this.connectionRooms.set(connectionId, connRooms)
      }

      // Skip if already in room
      if (connRooms.has(r)) {
        continue
      }

      // Add to connection -> rooms mapping
      connRooms.add(r)

      // Get or create room's connection set
      let roomConns = this.roomConnections.get(r)
      const wasEmpty = !roomConns || roomConns.size === 0
      if (!roomConns) {
        roomConns = new Set()
        this.roomConnections.set(r, roomConns)
      }

      // Add to room -> connections mapping
      roomConns.add(connectionId)

      // Subscribe via adapter if this is the first connection in the room on this node
      if (wasEmpty) {
        this.adapter.subscribe(r).catch(() => {
          // Log error but don't throw - subscription failure shouldn't break join
        })
      }
    }
  }

  /**
   * Leave one or more rooms.
   *
   * @param connectionId - The connection to remove from rooms
   * @param room - Room name or array of room names
   */
  leave(connectionId: string, room: string | string[]): void {
    const rooms = Array.isArray(room) ? room : [room]

    for (const r of rooms) {
      // Remove from connection -> rooms mapping
      const connRooms = this.connectionRooms.get(connectionId)
      if (connRooms) {
        connRooms.delete(r)
        if (connRooms.size === 0) {
          this.connectionRooms.delete(connectionId)
        }
      }

      // Remove from room -> connections mapping
      const roomConns = this.roomConnections.get(r)
      if (roomConns) {
        roomConns.delete(connectionId)
        if (roomConns.size === 0) {
          this.roomConnections.delete(r)
          // Unsubscribe via adapter - no more local connections in this room
          this.adapter.unsubscribe(r).catch(() => {
            // Log error but don't throw
          })
        }
      }
    }
  }

  /**
   * Leave all rooms for a connection.
   * Called automatically when a connection disconnects.
   *
   * @param connectionId - The connection to remove from all rooms
   * @returns Array of room names the connection was in
   */
  leaveAll(connectionId: string): string[] {
    const connRooms = this.connectionRooms.get(connectionId)
    if (!connRooms) {
      return []
    }

    const rooms = Array.from(connRooms)
    this.leave(connectionId, rooms)
    return rooms
  }

  /**
   * Get all rooms a connection is in.
   *
   * @param connectionId - The connection to query
   * @returns Array of room names
   */
  getRooms(connectionId: string): string[] {
    const rooms = this.connectionRooms.get(connectionId)
    return rooms ? Array.from(rooms) : []
  }

  /**
   * Get all connection IDs in a room.
   *
   * @param room - The room to query
   * @returns Array of connection IDs
   */
  getConnectionsInRoom(room: string): string[] {
    const connections = this.roomConnections.get(room)
    return connections ? Array.from(connections) : []
  }

  /**
   * Get the number of connections in a room.
   *
   * @param room - The room to query
   * @returns Number of connections
   */
  getConnectionCountInRoom(room: string): number {
    const connections = this.roomConnections.get(room)
    return connections?.size ?? 0
  }

  /**
   * Check if a connection is in a specific room.
   *
   * @param connectionId - The connection to check
   * @param room - The room to check
   * @returns true if the connection is in the room
   */
  isInRoom(connectionId: string, room: string): boolean {
    const rooms = this.connectionRooms.get(connectionId)
    return rooms?.has(room) ?? false
  }

  /**
   * Get all room names that have at least one connection.
   *
   * @returns Array of room names
   */
  getAllRooms(): string[] {
    return Array.from(this.roomConnections.keys())
  }

  /**
   * Publish a message to a room via the adapter.
   * This propagates the message to other nodes.
   *
   * @param room - The room to publish to
   * @param message - The SSE message to broadcast
   * @param options - Broadcast options
   */
  async publish(room: string, message: SSEMessage, options?: RoomBroadcastOptions): Promise<void> {
    if (options?.local) {
      return // Skip adapter for local-only broadcasts
    }

    const except = Array.isArray(options?.except) ? options.except[0] : options?.except
    await this.adapter.publish(room, message, except)
  }
}
