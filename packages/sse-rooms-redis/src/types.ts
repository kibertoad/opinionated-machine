import type { SSEMessage } from 'opinionated-machine'
import type { PresenceTracker } from './presence/types.ts'

/**
 * Minimal interface for a Redis-like client used by the classic
 * (non-sharded) `RedisAdapter`.
 *
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
 * Minimal interface for a Redis Cluster-aware client used by the sharded
 * `RedisShardedAdapter`. Mirrors `RedisClientLike` with the sharded pub/sub
 * commands (Redis 7.0+ / Valkey).
 *
 * - ioredis: a `Cluster` instance exposes `spublish` / `ssubscribe` /
 *   `sunsubscribe` and emits `'smessage'` on incoming sharded messages.
 * - node-redis: `createCluster` clients expose the same commands; wire up
 *   incoming messages either via the callback form of `sSubscribe` or with
 *   a small `on('smessage', ...)` adapter.
 */
export type RedisShardedClientLike = {
  /** Publish to a sharded channel (SPUBLISH). */
  spublish(channel: string, message: string): Promise<number>

  /** Subscribe to one or more sharded channels (SSUBSCRIBE). */
  ssubscribe(...channels: string[]): Promise<unknown>

  /** Unsubscribe from one or more sharded channels (SUNSUBSCRIBE). */
  sunsubscribe(...channels: string[]): Promise<unknown>

  /**
   * Register a sharded-message handler.
   * @param event - The event type ('smessage' for sharded pub/sub messages)
   * @param handler - The handler function
   */
  on(event: 'smessage', handler: (channel: string, message: string) => void): void
}

/**
 * Configuration for the classic (non-sharded) Redis adapter.
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

  /**
   * Optional presence tracker. When set, the adapter consults it before each
   * publish and skips the `PUBLISH` when the tracker reports no subscribers
   * anywhere in the cluster. Pair with `NumsubPresenceTracker` for classic
   * pub/sub.
   *
   * The tracker's `channelPrefix` MUST match this adapter's `channelPrefix`
   * — otherwise the tracker queries the wrong Redis channels.
   *
   * @default undefined (every publish goes out — original behaviour)
   */
  presence?: PresenceTracker

  /**
   * Optional observability hook fired when `presence.hasSubscribers` throws
   * or rejects. The adapter still publishes (fail-open) — this hook only
   * exists so operators can detect a silently-broken tracker (e.g. a stale
   * connection that returns errors indefinitely).
   *
   * Errors thrown from this hook itself are swallowed; it must not break
   * publishing.
   *
   * @default undefined (errors are silently swallowed, fail-open as before)
   */
  onPresenceError?: (error: unknown, room: string) => void
}

/**
 * Configuration for the sharded (Redis Cluster / Valkey) adapter.
 */
export type RedisShardedAdapterConfig = {
  /** Cluster-aware Redis client for publishing (SPUBLISH). */
  pubClient: RedisShardedClientLike

  /**
   * Cluster-aware Redis client for subscribing (SSUBSCRIBE).
   * MUST be a separate connection from `pubClient`.
   */
  subClient: RedisShardedClientLike

  /**
   * Prefix for sharded channel names.
   * @default 'sse:room:'
   */
  channelPrefix?: string

  /**
   * Unique identifier for this server node.
   * @default crypto.randomUUID()
   */
  nodeId?: string

  /**
   * Optional presence tracker. Pair with `ShardedNumsubPresenceTracker` for
   * Redis sharded pub/sub.
   *
   * @default undefined
   */
  presence?: PresenceTracker

  /**
   * Optional observability hook fired when `presence.hasSubscribers` throws
   * or rejects. The adapter still publishes (fail-open) — this hook only
   * exists so operators can detect a silently-broken tracker.
   *
   * Errors thrown from this hook itself are swallowed; it must not break
   * publishing.
   *
   * @default undefined
   */
  onPresenceError?: (error: unknown, room: string) => void
}

/**
 * Message format for Redis pub/sub. Shared by both adapters.
 *
 * `meta` is optional — present only when a publisher attaches metadata for
 * subscription filtering. Older readers (no metadata support) ignore the
 * extra field; newer readers receive `undefined` when it is absent.
 */
export type RedisRoomMessage = {
  v: 1
  m: SSEMessage
  n: string
  meta?: Record<string, unknown>
}
