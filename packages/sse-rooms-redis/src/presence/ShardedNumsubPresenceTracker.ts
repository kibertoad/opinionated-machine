import {
  CachedPubsubCountTracker,
  type CachedPubsubCountTrackerConfig,
} from './CachedPubsubCountTracker.ts'

/**
 * Configuration for `ShardedNumsubPresenceTracker`.
 *
 * Mirrors `CachedPubsubCountTrackerConfig`; re-exported here so callers can
 * import it from the same module as the tracker class.
 */
export type ShardedNumsubPresenceTrackerConfig = CachedPubsubCountTrackerConfig

/**
 * Presence tracker for Redis sharded Pub/Sub (Redis 7.0+ / Valkey).
 *
 * Uses `PUBSUB SHARDNUMSUB <channel>` — the sharded equivalent of `NUMSUB` —
 * which counts subscribers on a single shard rather than across the whole
 * cluster. Pair with `RedisShardedAdapter`.
 *
 * Works against:
 * - Self-hosted Redis Cluster (>= 7.0)
 * - AWS ElastiCache for Redis OSS 7+ (Cluster Mode Enabled)
 * - AWS ElastiCache for Valkey (Cluster Mode Enabled, all versions)
 * - AWS ElastiCache Serverless (translates classic pub/sub commands to
 *   sharded internally — but using the sharded adapter directly avoids the
 *   translation overhead).
 *
 * @example
 * ```typescript
 * import { Cluster } from 'ioredis'
 * import {
 *   RedisShardedAdapter,
 *   ShardedNumsubPresenceTracker,
 * } from '@opinionated-machine/sse-rooms-redis'
 *
 * const pubClient = new Cluster([{ host: 'redis-cluster', port: 6379 }])
 * const subClient = new Cluster([{ host: 'redis-cluster', port: 6379 }])
 *
 * const adapter = new RedisShardedAdapter({
 *   pubClient,
 *   subClient,
 *   presence: new ShardedNumsubPresenceTracker({ client: pubClient }),
 * })
 * ```
 */
export class ShardedNumsubPresenceTracker extends CachedPubsubCountTracker {
  protected readonly subscriberCountCommand = 'SHARDNUMSUB' as const
}
