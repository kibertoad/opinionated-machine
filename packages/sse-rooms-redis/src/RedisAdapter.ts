import { randomUUID } from 'node:crypto'
import type { SSEMessage, SSERoomAdapter, SSERoomMessageHandler } from 'opinionated-machine'
import { decodePayload, encodePayload } from './internal/payload.ts'
import type { PresenceTracker } from './presence/types.ts'
import type { RedisAdapterConfig } from './types.ts'

/**
 * Redis Pub/Sub adapter for cross-node SSE room communication.
 *
 * This adapter uses classic (non-sharded) Redis pub/sub to propagate room
 * broadcasts across multiple server nodes. Each node subscribes to channels
 * for rooms that have local connections.
 *
 * For Redis Cluster (or ElastiCache Cluster Mode Enabled), use
 * `RedisShardedAdapter` instead — it uses sharded pub/sub commands which
 * scope each message to a single shard rather than the whole cluster bus.
 *
 * **Requirements:**
 * - Two separate Redis connections (pub and sub)
 * - Redis 2.0+ (for pub/sub support)
 *
 * **Message Format:**
 * ```json
 * {
 *   "v": 1,                  // Protocol version
 *   "m": { SSEMessage },     // The event to broadcast
 *   "n": "node-id",          // Source node ID
 *   "meta": { ... }          // Optional metadata for subscription filtering
 * }
 * ```
 *
 * @example Basic usage with ioredis
 * ```typescript
 * import Redis from 'ioredis'
 * import { RedisAdapter } from '@opinionated-machine/sse-rooms-redis'
 *
 * const pubClient = new Redis()
 * const subClient = pubClient.duplicate()
 *
 * const adapter = new RedisAdapter({ pubClient, subClient })
 * ```
 *
 * @example With presence-aware publishing
 * ```typescript
 * import Redis from 'ioredis'
 * import {
 *   RedisAdapter,
 *   NumsubPresenceTracker,
 * } from '@opinionated-machine/sse-rooms-redis'
 *
 * const pubClient = new Redis()
 * const subClient = pubClient.duplicate()
 *
 * const adapter = new RedisAdapter({
 *   pubClient,
 *   subClient,
 *   presence: new NumsubPresenceTracker({ client: pubClient }),
 * })
 * ```
 */
export class RedisAdapter implements SSERoomAdapter {
  private readonly pubClient: RedisAdapterConfig['pubClient']
  private readonly subClient: RedisAdapterConfig['subClient']
  private readonly channelPrefix: string
  private readonly nodeId: string
  private readonly presence?: PresenceTracker
  private readonly onPresenceError?: (error: unknown, room: string) => void
  private messageHandler?: SSERoomMessageHandler
  private readonly subscribedChannels: Set<string> = new Set()

  constructor(config: RedisAdapterConfig) {
    this.pubClient = config.pubClient
    this.subClient = config.subClient
    this.channelPrefix = config.channelPrefix ?? 'sse:room:'
    this.nodeId = config.nodeId ?? randomUUID()
    this.presence = config.presence
    this.onPresenceError = config.onPresenceError
  }

  connect(): Promise<void> {
    // Set up message handler on subscriber client
    this.subClient.on('message', (channel: string, message: string) => {
      this.handleMessage(channel, message)
    })
    return Promise.resolve()
  }

  async disconnect(): Promise<void> {
    // Unsubscribe from all channels
    const channels = Array.from(this.subscribedChannels)
    if (channels.length > 0) {
      await this.subClient.unsubscribe(...channels)
    }
    this.subscribedChannels.clear()
    await this.presence?.dispose?.()
  }

  async subscribe(room: string): Promise<void> {
    const channel = this.getChannelName(room)
    if (this.subscribedChannels.has(channel)) {
      return // Already subscribed
    }

    await this.subClient.subscribe(channel)
    this.subscribedChannels.add(channel)
    // Pre-warm the presence tracker AFTER the subscribe resolves, so a racing
    // remote publisher would not see the tracker say "yes" before this node
    // is actually ready to receive.
    this.presence?.notifyLocalSubscribed?.(room)
  }

  async unsubscribe(room: string): Promise<void> {
    const channel = this.getChannelName(room)
    if (!this.subscribedChannels.has(channel)) {
      return // Not subscribed
    }

    await this.subClient.unsubscribe(channel)
    this.subscribedChannels.delete(channel)
    this.presence?.notifyLocalUnsubscribed?.(room)
  }

  async publish(
    room: string,
    message: SSEMessage,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    if (this.presence) {
      try {
        const has = await this.presence.hasSubscribers(room)
        if (!has) {
          return // Fast-path skip: nobody anywhere is subscribed.
        }
      } catch (err) {
        // Fail-open: a tracker error must never suppress a real publish.
        // Surface the error via the optional observability hook so operators
        // can detect a silently-broken tracker. The hook itself must not
        // disrupt publishing.
        if (this.onPresenceError) {
          try {
            this.onPresenceError(err, room)
          } catch {
            // Hook errors are intentionally swallowed.
          }
        }
      }
    }

    const channel = this.getChannelName(room)
    await this.pubClient.publish(channel, encodePayload(message, this.nodeId, metadata))
  }

  onMessage(handler: SSERoomMessageHandler): void {
    this.messageHandler = handler
  }

  /**
   * Get the Redis channel name for a room.
   */
  private getChannelName(room: string): string {
    return `${this.channelPrefix}${room}`
  }

  /**
   * Extract room name from Redis channel name.
   */
  private getRoomFromChannel(channel: string): string {
    return channel.slice(this.channelPrefix.length)
  }

  /**
   * Handle incoming messages from Redis.
   *
   * The handler may be async, but we deliberately do not await it here:
   * `node-redis` / `ioredis` invoke this synchronously per channel message,
   * and awaiting would serialize delivery across all rooms on this node.
   * We attach a `.catch` to surface async handler errors without crashing
   * the subscriber via an unhandled rejection.
   */
  private handleMessage(channel: string, rawMessage: string): void {
    if (!this.messageHandler) {
      return
    }

    const decoded = decodePayload(rawMessage)
    if (!decoded) {
      return // Invalid JSON or unknown protocol version
    }

    const room = this.getRoomFromChannel(channel)
    const result = this.messageHandler(
      room,
      decoded.message,
      decoded.sourceNodeId,
      decoded.metadata,
    )
    if (result && typeof (result as Promise<void>).catch === 'function') {
      ;(result as Promise<void>).catch(() => {
        // Swallow to prevent unhandled rejection; downstream is expected to log.
      })
    }
  }
}
