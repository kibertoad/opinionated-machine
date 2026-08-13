import {
  CachedPubsubCountTracker,
  type CachedPubsubCountTrackerConfig,
} from './CachedPubsubCountTracker.ts'

/**
 * Configuration for `NumsubPresenceTracker`.
 *
 * Mirrors `CachedPubsubCountTrackerConfig`; re-exported here so callers can
 * import it from the same module as the tracker class.
 */
export type NumsubPresenceTrackerConfig = CachedPubsubCountTrackerConfig

/**
 * Presence tracker for classic (non-sharded) Redis Pub/Sub.
 *
 * Uses `PUBSUB NUMSUB <channel>` to ask Redis directly how many subscribers
 * a channel has, then caches the answer with asymmetric TTLs (long for
 * "yes", short for "no"). Pair with `RedisAdapter`.
 *
 * Works against:
 * - Self-hosted Redis (standalone or replicated, any version >= 2.8)
 * - AWS ElastiCache for Redis OSS (Cluster Mode Disabled)
 * - AWS ElastiCache for Valkey (Cluster Mode Disabled)
 *
 * For Redis Cluster / ElastiCache Cluster Mode Enabled, use
 * `ShardedNumsubPresenceTracker` paired with `RedisShardedAdapter`.
 *
 * @example
 * ```typescript
 * import Redis from 'ioredis'
 * import { RedisAdapter, NumsubPresenceTracker } from '@opinionated-machine/sse-rooms-redis'
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
export class NumsubPresenceTracker extends CachedPubsubCountTracker {
  protected readonly subscriberCountCommand = 'NUMSUB' as const
}
