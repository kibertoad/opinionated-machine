import type { NumsubCapableClient, PresenceTracker } from './types.ts'

/**
 * Base configuration shared by NUMSUB / SHARDNUMSUB trackers.
 */
export type CachedPubsubCountTrackerConfig = {
  /**
   * Redis client used to issue raw `PUBSUB ...` commands. Must support
   * `call` (ioredis) or `sendCommand` (node-redis).
   */
  client: NumsubCapableClient

  /**
   * Prefix used to build the Redis channel name from a room name.
   * MUST match the prefix used by the adapter the tracker is wired to.
   *
   * @default 'sse:room:'
   */
  channelPrefix?: string

  /**
   * How long a "yes, there are subscribers" answer is cached, in ms.
   * Staleness here means "publish to a room that just emptied" — the
   * publish goes through, hits zero subscribers, and is dropped on the
   * Redis floor. Same behaviour as having no tracker at all. Safe to keep
   * comfortably long.
   *
   * @default 30_000
   */
  hasSubscribersTtlMs?: number

  /**
   * How long a "no subscribers" answer is cached, in ms. Staleness here
   * means "skip a publish for a room someone just joined" — a real message
   * is dropped. Keep this tight.
   *
   * Local subscribes invalidate the cache eagerly via
   * `notifyLocalSubscribed`, so the realistic window where this matters is
   * a remote node joining the room between cache writes.
   *
   * @default 1_000
   */
  noSubscribersTtlMs?: number

  /**
   * Maximum number of cached entries before LRU eviction kicks in.
   *
   * @default 10_000
   */
  maxCacheEntries?: number
}

type CacheEntry = { result: boolean; expiresAt: number }

/**
 * Shared caching logic for NUMSUB-style presence trackers. Concrete subclasses
 * pick the Redis command used to count subscribers.
 *
 * The cache uses asymmetric TTLs (see config). On a fresh local subscribe the
 * cache is pre-warmed to `true`, eliminating the "node just joined but cache
 * says no" race for self-initiated joins.
 */
export abstract class CachedPubsubCountTracker implements PresenceTracker {
  protected readonly client: NumsubCapableClient
  protected readonly channelPrefix: string
  protected readonly hasSubscribersTtlMs: number
  protected readonly noSubscribersTtlMs: number
  protected readonly maxCacheEntries: number

  /** Map preserves insertion order, which we use for LRU eviction. */
  private readonly cache: Map<string, CacheEntry> = new Map()

  /** Redis command name used to count subscribers on a channel. */
  protected abstract readonly subscriberCountCommand: 'NUMSUB' | 'SHARDNUMSUB'

  constructor(config: CachedPubsubCountTrackerConfig) {
    if (
      typeof config.client.call !== 'function' &&
      typeof config.client.sendCommand !== 'function'
    ) {
      throw new Error(
        'Presence tracker requires a Redis client exposing `call` (ioredis) or `sendCommand` (node-redis).',
      )
    }
    this.client = config.client
    this.channelPrefix = config.channelPrefix ?? 'sse:room:'
    this.hasSubscribersTtlMs = config.hasSubscribersTtlMs ?? 30_000
    this.noSubscribersTtlMs = config.noSubscribersTtlMs ?? 1_000
    this.maxCacheEntries = config.maxCacheEntries ?? 10_000
  }

  async hasSubscribers(room: string): Promise<boolean> {
    const channel = this.channelPrefix + room
    const now = Date.now()
    const cached = this.cache.get(channel)
    if (cached && cached.expiresAt > now) {
      // Touch for LRU recency.
      this.cache.delete(channel)
      this.cache.set(channel, cached)
      return cached.result
    }

    const count = await this.queryCount(channel)
    const result = count > 0
    this.setCached(channel, result, now)
    return result
  }

  notifyLocalSubscribed(room: string): void {
    // We just gained a local subscriber. The answer is now definitively
    // "yes" — pre-warm the cache so the next publish doesn't go ask Redis.
    const channel = this.channelPrefix + room
    this.setCached(channel, true, Date.now())
  }

  notifyLocalUnsubscribed(room: string): void {
    // Our local node no longer has a subscriber. We don't know whether other
    // nodes still do, so invalidate and let the next publish re-query.
    this.cache.delete(this.channelPrefix + room)
  }

  dispose(): void {
    this.cache.clear()
  }

  protected async queryCount(channel: string): Promise<number> {
    // Both NUMSUB and SHARDNUMSUB return [channel, count, channel, count, ...]
    const result = (await this.callRedis(['PUBSUB', this.subscriberCountCommand, channel])) as
      | ReadonlyArray<string | number>
      | null
      | undefined
    return Number(result?.[1] ?? 0)
  }

  private callRedis(args: string[]): Promise<unknown> {
    if (typeof this.client.call === 'function') {
      // ioredis: client.call('PUBSUB', 'NUMSUB', 'chan')
      const [head, ...rest] = args
      return this.client.call(head as string, ...rest)
    }
    // node-redis: client.sendCommand(['PUBSUB', 'NUMSUB', 'chan']). The
    // constructor guarantees one of `call` / `sendCommand` is present, so
    // reaching here with `sendCommand` undefined is unreachable in practice
    // — we still guard at runtime to keep the type system happy without a
    // non-null assertion.
    const sendCommand = this.client.sendCommand
    if (typeof sendCommand !== 'function') {
      throw new Error('Presence tracker client has neither `call` nor `sendCommand`.')
    }
    // Signature is permissive (returns `any`) so coerce to Promise for the caller.
    return Promise.resolve(sendCommand(args))
  }

  private setCached(channel: string, result: boolean, now: number): void {
    // Evict if at capacity. `Map` preserves insertion order, so the first
    // key is the oldest.
    if (this.cache.size >= this.maxCacheEntries && !this.cache.has(channel)) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) {
        this.cache.delete(oldest)
      }
    }
    // Re-insert to move to the end (most recent).
    this.cache.delete(channel)
    const ttlMs = result ? this.hasSubscribersTtlMs : this.noSubscribersTtlMs
    this.cache.set(channel, { result, expiresAt: now + ttlMs })
  }
}
