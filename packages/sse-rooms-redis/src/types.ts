/**
 * Minimal interface for a Redis-like client.
 * Compatible with ioredis, node-redis, and similar libraries.
 */
export type RedisClientLike = {
  /**
   * Publish a message to a channel.
   * @param channel - The channel to publish to
   * @param message - The message to publish (string)
   */
  publish(channel: string, message: string): Promise<number>

  /**
   * Subscribe to one or more channels.
   * @param channels - The channel(s) to subscribe to
   */
  subscribe(...channels: string[]): Promise<unknown>

  /**
   * Unsubscribe from one or more channels.
   * @param channels - The channel(s) to unsubscribe from
   */
  unsubscribe(...channels: string[]): Promise<unknown>

  /**
   * Register a message handler.
   * @param event - The event type ('message' for pub/sub messages)
   * @param handler - The handler function
   */
  on(event: 'message', handler: (channel: string, message: string) => void): void
}

/**
 * Configuration for the Redis adapter.
 */
export type RedisAdapterConfig = {
  /**
   * Redis client for publishing messages.
   * This client should be dedicated to publishing.
   */
  pubClient: RedisClientLike

  /**
   * Redis client for subscribing to messages.
   * This MUST be a separate connection from pubClient, as Redis
   * clients in subscriber mode can only receive messages.
   */
  subClient: RedisClientLike

  /**
   * Prefix for Redis channel names.
   * @default 'sse:room:'
   */
  channelPrefix?: string

  /**
   * Unique identifier for this server node.
   * Used to prevent message echo.
   * @default crypto.randomUUID()
   */
  nodeId?: string
}

/**
 * Message format for Redis pub/sub.
 */
export type RedisRoomMessage = {
  /** Protocol version for future compatibility */
  v: 1
  /** The SSE message to broadcast */
  m: {
    event?: string
    data: unknown
    id?: string
    retry?: number
  }
  /** Source node ID */
  n: string
}
