# Presence-Aware Publishing

Optional opt-in optimisation for the Redis adapters in this package. **Default behaviour is unchanged when no `presence` config is supplied — every `publish()` goes through.** Read this document before enabling it; the economics are narrower than they sound.

---

## TL;DR

- The tracker skips `PUBLISH` / `SPUBLISH` when no node anywhere has a subscriber.
- It does this by querying `PUBSUB NUMSUB` / `PUBSUB SHARDNUMSUB` and caching the result with asymmetric TTLs (long for "yes", short for "no").
- **Break-even is ~2 publishes per second to the same empty room.** Below that rate, the NUMSUB query you pay roughly equals the PUBLISH you avoid — same number of round-trips, just renamed.
- **Recommended default: don't enable this.** Enable it only if you've measured a workload where the same set of empty rooms receives publishes faster than once per second.

---

## What it actually does

```
publish(room, msg)
  ├── presence.hasSubscribers(room)?
  │     ├── cache hit  → return cached boolean      (no Redis call)
  │     └── cache miss → PUBSUB NUMSUB <channel>    (1 RTT)
  │
  ├── false → skip                                  (saved a PUBLISH)
  ├── true  → pubClient.publish(channel, payload)   (1 RTT)
  └── threw → onPresenceError?(err, room); publish anyway (fail-open)
```

Cache population:

| Trigger | Behaviour |
|---|---|
| Local `subscribe()` resolves | Pre-warm entry to `true` (eager, free). Eliminates the self-join race. |
| Local `unsubscribe()` resolves | Invalidate entry. |
| `publish()` cache miss | Lazy: issue `PUBSUB NUMSUB`, store result. |
| `publish()` cache hit | No Redis call. |
| Background timer / SCAN | **Not implemented.** No periodic refresh, no proactive warming. |

So caches are **lazy** with one **eager** exception for local subscribers.

---

## Break-even math — read this before enabling

Both `PUBLISH` and `PUBSUB NUMSUB` are 1-RTT, O(1) Redis commands. Their costs are roughly equivalent. The cache for `false` lasts 1s by default. So for an empty room receiving `N` publishes within one second:

| Strategy | RTTs |
|---|---|
| No tracker | `N` × PUBLISH |
| Tracker | 1 × NUMSUB + (N-1) × skip |

**Break-even: `N = 2`.** At one publish per second per empty room, you have not saved anything — you've replaced PUBLISH with NUMSUB at the same rate.

### Realistic walk-through: per-user fanout to mostly-offline rooms

Imagine the canonical "downstream service publishes one message per affected user per inbound event" workload — 1000 users, most offline:

- **Single event, all offline:** 1000 cache misses → 1000 NUMSUB calls. The first publish per room is *not* skipped on a cold cache — it's the NUMSUB returning 0 that caches `false`. Same RTT count as no tracker.
- **Second event ~1s later, same 1000 users:** all cache hits → 1000 skips. Big win.
- **Second event 5s later (cache expired):** 1000 more NUMSUB calls. No win.

The tracker only pays off when the **same set of rooms** receives publishes faster than 1 per second.

### When this actually applies

- Heartbeat or tick-style publishers (e.g. per-symbol market-data updates, per-channel telemetry) where most channels are sparse and the publisher emits at ≥2 Hz.
- Bursty rebroadcasts where the same room set is hit repeatedly within a second.
- Activity-feed-style batching across many events where the same rooms recur in rapid succession.

### When it doesn't apply (i.e. most SSE workloads)

- Chat applications: rooms with subscribers cache `true`; the tracker does nothing useful.
- Per-user notifications at human-perceptible rates (a few per minute per user): cache always cold; tracker is net-zero.
- Single-shot fan-outs where a room receives one publish and then nothing for hours: every publish pays a cold-cache NUMSUB. **Strict 2× RTT regression** vs no tracker.
- Bursty fan-out across many *unique* rooms past `maxCacheEntries` (default 10k): LRU eviction causes thrashing; degrades toward the single-shot case.

---

## Bundled trackers

Two implementations that share the `CachedPubsubCountTracker` base:

| Class | Command | Pair with |
|---|---|---|
| `NumsubPresenceTracker` | `PUBSUB NUMSUB` | `RedisAdapter` |
| `ShardedNumsubPresenceTracker` | `PUBSUB SHARDNUMSUB` | `RedisShardedAdapter` |

### Usage

```typescript
import Redis from 'ioredis'
import { RedisAdapter, NumsubPresenceTracker } from '@opinionated-machine/sse-rooms-redis'

const pubClient = new Redis()
const subClient = pubClient.duplicate()

const adapter = new RedisAdapter({
  pubClient,
  subClient,
  presence: new NumsubPresenceTracker({ client: pubClient }),
})
```

Sharded equivalent:

```typescript
import { Cluster } from 'ioredis'
import { RedisShardedAdapter, ShardedNumsubPresenceTracker } from '@opinionated-machine/sse-rooms-redis'

const pubClient = new Cluster([{ host: 'redis-cluster', port: 6379 }])
const subClient = new Cluster([{ host: 'redis-cluster', port: 6379 }])

const adapter = new RedisShardedAdapter({
  pubClient,
  subClient,
  presence: new ShardedNumsubPresenceTracker({ client: pubClient }),
})
```

### Configuration

Both trackers share the same options:

```typescript
type CachedPubsubCountTrackerConfig = {
  /** Redis client (ioredis or node-redis). Must expose `call` or `sendCommand`. */
  client: NumsubCapableClient

  /** Must match the adapter's channelPrefix. Default: 'sse:room:'. */
  channelPrefix?: string

  /** How long "has subscribers = true" is cached. Default: 30000ms.
   *  Staleness here just means publishing to a room that recently emptied —
   *  identical to having no tracker. Safe to keep long. */
  hasSubscribersTtlMs?: number

  /** How long "has subscribers = false" is cached. Default: 1000ms.
   *  Staleness here means skipping a publish for a room that just gained a
   *  remote subscriber — a real message is dropped. Keep tight. */
  noSubscribersTtlMs?: number

  /** Max cached entries; oldest evicted first. Default: 10000. */
  maxCacheEntries?: number
}
```

### Tuning `noSubscribersTtlMs`

The break-even rate is `1 / noSubscribersTtlMs`. Raising it shifts break-even down — but proportionally widens the window where a remote subscriber's join is invisible and a real message is silently skipped. The 1s default keeps that window tight at the cost of needing ≥2 publish/sec to amortise.

| `noSubscribersTtlMs` | Break-even rate (publish/sec/room) | Max stale-false window |
|---|---|---|
| 1000 (default) | 2 | 1s |
| 5000 | 0.4 | 5s |
| 30000 | 0.07 | 30s |

If you raise this, also raise the visibility on the dropped-message risk for your callers — a 30s window is long enough that someone hitting the "this user isn't getting notifications" support ticket will be confused.

---

## Failure modes

| Scenario | Behaviour |
|---|---|
| `hasSubscribers` throws / rejects | Adapter publishes anyway (fail-open) and fires `onPresenceError` if set. |
| Tracker cached `false`, remote subscriber appeared moments ago | Publish skipped; one message dropped. Bounded by `noSubscribersTtlMs`. |
| Tracker cached `true`, everyone just left | Publish goes through to Redis, drops on the floor. Same as no tracker. |
| Tracker cached `false` for a locally-subscribed room | Cannot happen — local subscribes pre-warm the cache to `true` after `subscribe()` resolves. |
| Local node loses Redis connection mid-publish | `pubClient.publish` rejects to caller (unchanged behaviour). |
| `dispose()` throws on disconnect | Caught by the adapter; does not block `disconnect()`. |

## Observability — `onPresenceError`

Tracker errors are fail-open by design: the adapter never silently *drops* a publish because the tracker failed. But "silent fail-open" also means a tracker whose connection has died (e.g. the `pubClient` it shares with the adapter went into a long reconnect loop) can stay broken indefinitely without anything visible to operators.

Both adapters accept an optional `onPresenceError(error, room)` callback:

```typescript
const adapter = new RedisAdapter({
  pubClient,
  subClient,
  presence: new NumsubPresenceTracker({ client: pubClient }),
  onPresenceError: (err, room) => {
    logger.warn({ err, room }, 'presence tracker failed; publishing anyway')
    metrics.increment('sse.presence.error')
  },
})
```

- Fires on every `hasSubscribers` rejection or thrown error.
- Does **not** fire when the tracker returns normally (`true` or `false`).
- Errors thrown from the hook itself are swallowed — a buggy hook cannot break publishing.

---

## Custom trackers

The bundled trackers are not the only option. Implement `PresenceTracker` if you have a different source of truth — e.g. an in-process registry already maintained by your authentication layer, or an external presence service:

```typescript
import type { PresenceTracker } from '@opinionated-machine/sse-rooms-redis'

class MyPresenceTracker implements PresenceTracker {
  async hasSubscribers(room: string): Promise<boolean> {
    // your logic — local cache, external service, etc.
  }

  notifyLocalSubscribed?(room: string): void { /* optional */ }
  notifyLocalUnsubscribed?(room: string): void { /* optional */ }
  dispose?(): void | Promise<void> { /* optional */ }
}
```

The interface itself is cheap to ship and useful even if you don't use the bundled NUMSUB strategy.

---

## Design rationale

The interesting decisions behind the as-built design.

### Why NUMSUB and not a SET-based registry

An obvious alternative is to maintain a Redis SET per room (`<prefix>presence:<room>` → set of node IDs), populated via `SADD` / `SREM` on local subscribe / unsubscribe. The publisher checks `SCARD` before publishing.

Rejected because:

1. **It duplicates state Redis already maintains.** `PUBSUB NUMSUB` is exact, real-time, and free of the consistency issues a registry creates. A SET-based registry is a denormalised cache of the authoritative subscriber list — and any denormalised cache eventually diverges.
2. **Node-crash recovery requires a heartbeat.** If a node dies without running its `SREM`, its entry sticks in the SET forever and `SCARD > 0` always returns true. The standard mitigation is a periodic re-`SADD` with a TTL applied per heartbeat. At 10k rooms × 15s intervals that is ~667 background ops/sec just maintaining presence — a cost that scales with room count rather than publish rate.
3. **Heartbeats are not standard practice for this problem.** They are well established for *connection liveness* (WebSocket ping/pong, [WebSocket.org heartbeat guide](https://websocket.org/guides/heartbeat/)) — deciding whether a single TCP connection is dead. Distributed pub/sub presence registries are a different problem with a different shape. Centrifugo, which has the most production-hardened OSS presence implementation we found, uses TTL-on-event (refresh entries when something changes) rather than a background heartbeat ([Centrifugo engines and scalability](https://centrifugal.dev/docs/server/engines)).
4. **The official Socket.IO Redis adapter does not skip publishes either.** The exact "most fanouts hit empty rooms" scaling problem is filed as an unresolved feature request ([Issue #5226](https://github.com/socketio/socket.io/issues/5226)) — the discussion focuses on subscription patterns and Redis sharded pub/sub, not on application-level registries.

NUMSUB inverts all of this: Redis is the source of truth, every read is exact, and there is nothing to keep alive between reads.

### Why asymmetric TTLs

A naive cache uses one TTL for both answers. That is wrong for this problem: the two answers have very different failure modes.

| Cache says | Reality | Result of staleness |
|---|---|---|
| `hasSubscribers = true` | Room just emptied | One `PUBLISH` hits zero subscribers. Redis drops it. **Identical to having no tracker at all.** |
| `hasSubscribers = false` | Room just gained a subscriber | One real message is **silently dropped.** Bad. |

So we cache "yes" comfortably long (default 30s) and "no" tightly (default 1s). Local subscribes pre-warm the cache to `true` immediately, eliminating the "stale-false" risk for self-initiated joins; the remaining window where it matters is a *remote* node joining a room our node is publishing to.

This is the same idea as positive/negative TTLs in DNS — different consequences of staleness deserve different caching.

### Why this lives at the adapter layer, not the core library

The only component that knows the channel-name mapping is the adapter. Pushing presence into application code would force every consumer to re-derive the channel name and re-maintain bookkeeping the adapter already does on the subscribe/unsubscribe path. Pushing it into the core library would force `InMemoryAdapter` (single-node, where the optimisation is meaningless) to carry the concept too. The adapter is the right level.

### Why fail-open

Skipping a publish when uncertain would silently drop legitimate messages — a much worse failure mode than the redundant publish today. So when the tracker throws or rejects, the adapter publishes anyway. The optimisation is "skip *known* no-op publishes," never "skip *possibly* legitimate ones."

### Why pair the cluster case with sharded pub/sub

The two optimisations target different costs:

- **NUMSUB cache** eliminates the publisher's round-trip when nobody is subscribed (rate-threshold caveat above).
- **Sharded pub/sub** eliminates the cluster-bus fanout when the message is published.

On standalone Redis, only the first matters (there is no cluster bus). On Redis Cluster they stack — and AWS [explicitly recommends sharded pub/sub](https://docs.aws.amazon.com/AmazonElastiCache/latest/red-ug/BestPractices.PubSub.html) for high-throughput workloads on ElastiCache Cluster Mode Enabled and Valkey. ElastiCache Serverless already rewrites classic `PUBLISH` to `SPUBLISH` internally, so using the sharded adapter directly avoids the translation overhead.

The sharded adapter earns its keep independently of the tracker.

---

## References

- [Redis Pub/Sub documentation](https://redis.io/docs/latest/develop/pubsub/) — fire-and-forget semantics; messages to channels with no subscribers are dropped.
- [PUBSUB NUMSUB](https://redis.io/docs/latest/commands/pubsub-numsub/) — O(N) over the requested channel list. We query one channel per cache-miss.
- [Socket.IO scaling issue #5226](https://github.com/socketio/socket.io/issues/5226) — the same problem in the Socket.IO ecosystem, still unresolved.
- [Socket.IO Redis adapter](https://socket.io/docs/v4/redis-adapter/) — the dominant reference implementation; does not skip publishes.
- [Centrifugo engines and scalability](https://centrifugal.dev/docs/server/engines) — production presence implementation that uses TTL-on-event rather than heartbeats.
- [SSUBSCRIBE / SPUBLISH](https://redis.io/docs/latest/commands/ssubscribe/) — Redis 7.0 sharded pub/sub.
- [Amazon ElastiCache Pub/Sub best practices](https://docs.aws.amazon.com/AmazonElastiCache/latest/red-ug/BestPractices.PubSub.html) — AWS recommendation to use sharded pub/sub for high-throughput on Cluster Mode Enabled / Valkey.
- [WebSocket.org heartbeat guide](https://websocket.org/guides/heartbeat/) — heartbeats are the right tool for *connection* liveness, which is a different problem than cluster-wide subscriber presence.
