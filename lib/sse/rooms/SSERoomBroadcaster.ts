import { randomUUID } from 'node:crypto'
import type { z } from 'zod'
import type { SSEEventDefinition } from '../defineEvent.js'
import type { SSEMessage } from '../sseTypes.js'
import type { SSERoomManager } from './SSERoomManager.js'
import type { BroadcastResult, PreDeliveryFilter, RoomBroadcastOptions } from './types.js'

/** Maximum number of message IDs to cache per connection for deduplication */
const MAX_DEDUP_CACHE_SIZE = 1000

/**
 * Shared, non-generic room broadcaster that can be registered once in DI
 * and used by multiple controllers and domain services.
 *
 * Controllers register their `sendEvent` callback via `registerSender()`.
 * Domain services receive the broadcaster directly from the DI container.
 *
 * Requires `sseRoomManager` to be registered in the DI container.
 *
 * @example
 * ```typescript
 * // In your DI module's resolveDependencies()
 * sseRoomManager: asValue(new SSERoomManager()),
 * sseRoomBroadcaster: asSingletonClass(SSERoomBroadcaster),
 *
 * // In a domain service
 * class MetricsService {
 *   private readonly sseRoomBroadcaster: SSERoomBroadcaster
 *   constructor(deps: { sseRoomBroadcaster: SSERoomBroadcaster }) {
 *     this.sseRoomBroadcaster = deps.sseRoomBroadcaster
 *   }
 * }
 * ```
 */
export class SSERoomBroadcaster {
  private readonly _roomManager: SSERoomManager
  private readonly senders: ((connId: string, msg: SSEMessage) => Promise<boolean>)[] = []
  private readonly dedupCache: Map<string, Set<string>> = new Map()
  private preDeliveryFilter?: PreDeliveryFilter

  constructor(deps: { sseRoomManager: SSERoomManager }) {
    this._roomManager = deps.sseRoomManager

    // Wire up adapter message handler to forward remote broadcasts to local connections
    this._roomManager.onRemoteMessage((room, message, _sourceNodeId, metadata) => {
      return this.handleRemoteBroadcast(room, message, metadata)
    })
  }

  /**
   * Set a pre-delivery filter that runs before sending to each connection.
   * Used by SSESubscriptionManager for resolver pipeline evaluation.
   * Only one filter can be active at a time — calling this method twice throws,
   * to prevent silently replacing an already-installed filter (which is almost
   * always a wiring bug, e.g. registering two SSESubscriptionManagers).
   */
  setPreDeliveryFilter(filter: PreDeliveryFilter): void {
    if (this.preDeliveryFilter) {
      throw new Error(
        'SSERoomBroadcaster pre-delivery filter is already set; only one filter can be active at a time',
      )
    }
    this.preDeliveryFilter = filter
  }

  /**
   * Public getter for the underlying room manager.
   * Used by the route builder for `session.rooms`.
   */
  get roomManager(): SSERoomManager {
    return this._roomManager
  }

  /**
   * Register a sender callback (typically from a controller's sendEvent).
   * When broadcasting, each registered sender is tried — the first to return `true` wins.
   */
  registerSender(sendFn: (connId: string, msg: SSEMessage) => Promise<boolean>): void {
    this.senders.push(sendFn)
  }

  /**
   * Broadcast a type-safe event to all connections in one or more rooms.
   *
   * Domain services use this method with `defineEvent()`-based event definitions
   * for compile-time data validation.
   *
   * @param room - Room name or array of room names
   * @param event - Event definition created by `defineEvent()`
   * @param data - Event data (must match the schema from the event definition)
   * @param options - Broadcast options (local, id, retry)
   * @returns Number of local connections the message was successfully delivered to.
   *          For separate `delivered`/`filtered` counts, call {@link broadcastMessage}.
   */
  async broadcastToRoom<T extends z.ZodType>(
    room: string | string[],
    event: SSEEventDefinition<string, T>,
    data: z.input<T>,
    options?: RoomBroadcastOptions & {
      id?: string
      retry?: number
      metadata?: Record<string, unknown>
    },
  ): Promise<number> {
    const message: SSEMessage = {
      event: event.event,
      data,
      id: options?.id ?? randomUUID(),
      retry: options?.retry,
    }
    const { delivered } = await this.broadcastMessage(room, message, options)
    return delivered
  }

  /**
   * Lower-level broadcast API — sends a raw SSEMessage to all connections in one or more rooms.
   *
   * The controller's typed `broadcastToRoom()` delegates here after constructing the message.
   *
   * @param room - Room name or array of room names
   * @param message - The SSE message to broadcast
   * @param options - Broadcast options (local)
   * @returns `delivered` is the number of local connections the message was sent to;
   *          `filtered` is the number of local connections skipped by the pre-delivery
   *          filter. Returning both per-call (rather than tracking on the broadcaster)
   *          avoids races between concurrent broadcasts.
   */
  async broadcastMessage(
    room: string | string[],
    message: SSEMessage,
    options?: RoomBroadcastOptions & { metadata?: Record<string, unknown> },
  ): Promise<BroadcastResult> {
    const rooms = Array.isArray(room) ? room : [room]
    const connectionIds = this.collectRoomConnections(rooms)

    let delivered = 0
    let filtered = 0
    for (const connId of connectionIds) {
      // Check pre-delivery filter if set
      if (this.preDeliveryFilter) {
        const allowed = await this.preDeliveryFilter(connId, message, options?.metadata)
        if (!allowed) {
          filtered++
          continue
        }
      }
      if (await this.sendToConnection(connId, message)) {
        delivered++
      }
    }

    // Publish to adapter for cross-node propagation (unless local-only)
    if (!options?.local) {
      for (const r of rooms) {
        await this._roomManager.publish(r, message, options, options?.metadata)
      }
    }

    return { delivered, filtered }
  }

  /**
   * Get all connection IDs in a room.
   *
   * @param room - The room to query
   * @returns Array of connection IDs
   */
  getConnectionsInRoom(room: string): string[] {
    return this._roomManager.getConnectionsInRoom(room)
  }

  /**
   * Get the number of connections in a room.
   *
   * @param room - The room to query
   * @returns Number of connections
   */
  getConnectionCountInRoom(room: string): number {
    return this._roomManager.getConnectionCountInRoom(room)
  }

  /**
   * Clean up dedup cache for a disconnected connection.
   * Called by the controller when a connection is unregistered.
   */
  cleanupConnection(connectionId: string): void {
    this.dedupCache.delete(connectionId)
  }

  /**
   * Try each registered sender until one succeeds (only the owning controller can send).
   */
  private async sendToConnection(connId: string, msg: SSEMessage): Promise<boolean> {
    for (const sender of this.senders) {
      if (await sender(connId, msg)) {
        return true
      }
    }
    return false
  }

  /**
   * Handle broadcasts from other nodes (via adapter).
   * Deduplicates messages per-connection based on message ID.
   */
  private async handleRemoteBroadcast(
    room: string,
    message: SSEMessage,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const connectionIds = this._roomManager.getConnectionsInRoom(room)
    for (const connId of connectionIds) {
      if (this.isDuplicateMessage(connId, message.id)) {
        continue
      }
      if (this.preDeliveryFilter) {
        const allowed = await this.preDeliveryFilter(connId, message, metadata)
        if (!allowed) continue
      }
      await this.sendToConnection(connId, message)
    }
  }

  /**
   * Check if a message has already been delivered to a connection (deduplication).
   * Returns true if the message is a duplicate and should be skipped.
   */
  private isDuplicateMessage(connectionId: string, messageId: string | undefined): boolean {
    if (!messageId) {
      return false
    }

    let cache = this.dedupCache.get(connectionId)
    if (!cache) {
      cache = new Set()
      this.dedupCache.set(connectionId, cache)
    }

    if (cache.has(messageId)) {
      return true
    }

    // FIFO eviction: remove oldest entry if at capacity
    if (cache.size >= MAX_DEDUP_CACHE_SIZE) {
      const oldest = cache.values().next().value as string
      cache.delete(oldest)
    }

    cache.add(messageId)
    return false
  }

  /**
   * Collect unique connection IDs from multiple rooms.
   */
  private collectRoomConnections(rooms: string[]): Set<string> {
    const connectionIds = new Set<string>()
    for (const r of rooms) {
      for (const connId of this._roomManager.getConnectionsInRoom(r)) {
        connectionIds.add(connId)
      }
    }
    return connectionIds
  }
}
