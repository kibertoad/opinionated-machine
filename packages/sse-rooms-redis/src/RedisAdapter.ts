import { randomUUID } from 'node:crypto'
import type { SSEMessage, SSERoomAdapter, SSERoomMessageHandler } from 'opinionated-machine'
import type { RedisAdapterConfig, RedisRoomMessage } from './types.ts'

/**
 * Redis Pub/Sub adapter for cross-node SSE room communication.
 *
 * This adapter uses Redis pub/sub to propagate room broadcasts across
 * multiple server nodes. Each node subscribes to channels for rooms
 * that have local connections.
 *
 * **Requirements:**
 * - Two separate Redis connections (pub and sub)
 * - Redis 2.0+ (for pub/sub support)
 *
 * **Message Format:**
 * ```json
 * {
 *   "v": 1,              // Protocol version
 *   "m": { SSEMessage }, // The event to broadcast
 *   "n": "node-id"       // Source node ID
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
 * @example With node-redis
 * ```typescript
 * import { createClient } from 'redis'
 * import { RedisAdapter } from '@opinionated-machine/sse-rooms-redis'
 *
 * const pubClient = createClient()
 * const subClient = pubClient.duplicate()
 *
 * await pubClient.connect()
 * await subClient.connect()
 *
 * const adapter = new RedisAdapter({ pubClient, subClient })
 * ```
 */
export class RedisAdapter implements SSERoomAdapter {
  private readonly pubClient: RedisAdapterConfig['pubClient']
  private readonly subClient: RedisAdapterConfig['subClient']
  private readonly channelPrefix: string
  private readonly nodeId: string
  private messageHandler?: SSERoomMessageHandler
  private readonly subscribedChannels: Set<string> = new Set()

  constructor(config: RedisAdapterConfig) {
    this.pubClient = config.pubClient
    this.subClient = config.subClient
    this.channelPrefix = config.channelPrefix ?? 'sse:room:'
    this.nodeId = config.nodeId ?? randomUUID()
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
  }

  async subscribe(room: string): Promise<void> {
    const channel = this.getChannelName(room)
    if (this.subscribedChannels.has(channel)) {
      return // Already subscribed
    }

    await this.subClient.subscribe(channel)
    this.subscribedChannels.add(channel)
  }

  async unsubscribe(room: string): Promise<void> {
    const channel = this.getChannelName(room)
    if (!this.subscribedChannels.has(channel)) {
      return // Not subscribed
    }

    await this.subClient.unsubscribe(channel)
    this.subscribedChannels.delete(channel)
  }

  async publish(room: string, message: SSEMessage): Promise<void> {
    const channel = this.getChannelName(room)
    const payload: RedisRoomMessage = {
      v: 1,
      m: {
        event: message.event,
        data: message.data,
        id: message.id,
        retry: message.retry,
      },
      n: this.nodeId,
    }

    await this.pubClient.publish(channel, JSON.stringify(payload))
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
   */
  private handleMessage(channel: string, rawMessage: string): void {
    if (!this.messageHandler) {
      return
    }

    try {
      const payload = JSON.parse(rawMessage) as RedisRoomMessage

      // Validate protocol version
      if (payload.v !== 1) {
        return // Unknown protocol version, skip
      }

      const room = this.getRoomFromChannel(channel)
      const message: SSEMessage = {
        event: payload.m.event,
        data: payload.m.data,
        id: payload.m.id,
        retry: payload.m.retry,
      }

      this.messageHandler(room, message, payload.n)
    } catch {
      // Invalid JSON or message format, skip
    }
  }
}
