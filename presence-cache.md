# Presence-aware publishing for SSE rooms — final design

**Status:** Implemented in `@opinionated-machine/sse-rooms-redis`.
**Scope:** `@opinionated-machine/sse-rooms-redis` only (no core-library changes).
**Audience:** future maintainers / anyone evaluating extending this further.

This document captures the **as-built design** and the reasoning that led there. An earlier draft of this spec proposed a heartbeat-driven SET registry and a core-library `PresenceTracker` contract; both were rejected after research. The design here is what shipped.

---

## 1. Problem

Every call to `adapter.publish(room, message)` in the original `RedisAdapter` unconditionally issued a Redis `PUBLISH`, even when no node in the cluster had a subscriber for the target room. For applications that fan out per-user / per-team notifications to rooms where most users are offline (the motivating case: a downstream service that publishes one `PUBLISH` per affected user per inbound message), this wastes one Redis round-trip per non-delivery.

On Redis Cluster the cost is worse: classic `PUBLISH` propagates across the cluster bus to every node, multiplying the waste by shard count.

We want a way to skip publishes that would land on zero subscribers, **without**:

- Changing the wire format (`{ v, m, n, meta? }` is unchanged).
- Changing the public adapter API for non-opt-in callers (default behaviour unchanged).
- Introducing background timers or duplicate state to keep in sync with Redis.

---

## 2. What was built

Two complementary mechanisms, both shipped in `@opinionated-machine/sse-rooms-redis`. No changes to the core `opinionated-machine` library.

### 2.1 `PresenceTracker` interface + NUMSUB-based implementation

A thin contract local to the Redis package:

```ts
interface PresenceTracker {
  hasSubscribers(room: string): boolean | Promise<boolean>
  notifyLocalSubscribed?(room: string): void
  notifyLocalUnsubscribed?(room: string): void
  dispose?(): void | Promise<void>
}
```

Two bundled implementations:

- **`NumsubPresenceTracker`** — queries `PUBSUB NUMSUB <channel>` for the classic `RedisAdapter`.
- **`ShardedNumsubPresenceTracker`** — queries `PUBSUB SHARDNUMSUB <channel>` for the sharded adapter (see 2.2).

Both inherit caching logic from `CachedPubsubCountTracker`. The cache:

- Uses **asymmetric TTLs**: 30s default for "yes, has subscribers", 1s default for "no". See §3.2.
- **Pre-warms to `true`** on local `SUBSCRIBE` (`notifyLocalSubscribed`) — the local node knows definitively that a subscriber exists.
- **Invalidates** on local `UNSUBSCRIBE` — local node no longer knows the cluster-wide answer.
- Uses a `Map` for natural LRU ordering when `maxCacheEntries` is exceeded.

The adapters consume the tracker by calling `hasSubscribers` before each `PUBLISH`/`SPUBLISH`. On `false` they skip the publish entirely. On `true` they publish as normal. On thrown error they **fail open** and publish — see §3.4.

### 2.2 `RedisShardedAdapter` for Redis Cluster / Valkey

A sibling adapter using `SSUBSCRIBE` / `SUNSUBSCRIBE` / `SPUBLISH` (Redis 7.0+) and the `smessage` event. Channels hash to a single shard, so each message propagates only within its owning shard rather than across the entire cluster bus.

Use cases (per AWS docs):
- Self-hosted Redis Cluster (>= 7.0)
- AWS ElastiCache for Redis OSS 7+ (Cluster Mode Enabled)
- AWS ElastiCache for Valkey (all versions, Cluster Mode Enabled)
- AWS ElastiCache Serverless (which internally rewrites `PUBLISH` to `SPUBLISH` — using the sharded adapter directly avoids the translation)

Not for: standalone Redis, Redis Sentinel, or ElastiCache Cluster Mode Disabled. Those should keep using `RedisAdapter`.

The two adapters are siblings, not a base class + subclass. They share an internal codec for the `{ v, m, n, meta? }` wire payload (`src/internal/payload.ts`) and otherwise have intentional symmetric duplication (~150 LOC each). Inheritance would have required forcing the client typings together, which fights with the genuine type differences between `RedisClientLike` (classic) and `RedisShardedClientLike` (sharded). The duplication is small, symmetric, and easy to keep in sync — cheaper than an awkward abstraction at this scale.

### 2.3 No core-library changes

The `PresenceTracker` interface is exported from `@opinionated-machine/sse-rooms-redis`, not from `opinionated-machine`. Rationale:

- The `InMemoryAdapter` in the core library has no use for it (single-node, the optimisation is meaningless).
- A second adapter package (e.g., NATS, RabbitMQ) wanting the same concept can either import from the Redis package or define its own — there is no architectural pressure to elevate it to the core today.
- This keeps the core contract for `SSERoomAdapter` unchanged.

If a third adapter eventually wants to reuse `PresenceTracker`, we can promote it then. Premature abstraction would tax every consumer for a benefit none of them needs.

---

## 3. Design decisions (and what was rejected)

### 3.1 NUMSUB rather than a SET-based registry

**Rejected approach:** maintain `<prefix>presence:<room>` SETs of node IDs; SADD on local subscribe, SREM on local unsubscribe, SCARD to check presence, periodic heartbeat re-SADD to recover from crashes.

**Why rejected:**

1. **Duplicates state Redis already maintains.** Redis pub/sub knows exactly which nodes are subscribed to a channel — that is what `PUBSUB NUMSUB` reads. A SET registry is a denormalised cache; denormalised caches diverge from their source, and patching divergence is the whole reason heartbeats appear in such designs.
2. **Heartbeat cost scales with rooms, not with publish volume.** At 10k rooms × 15s intervals, that is ~667 background ops/sec just to keep presence alive — paid even when no publishes happen.
3. **Heartbeats are not standard practice for pub/sub presence registries.** Research found:
   - The Socket.IO Redis adapter does not skip publishes ([issue #5226](https://github.com/socketio/socket.io/issues/5226) tracks the request — unresolved).
   - Centrifugo, the most production-hardened OSS presence implementation we found, uses TTL-on-event (refresh entries on state change), not background heartbeats.
   - Heartbeats are universally used for *connection liveness* (WebSocket ping/pong, NAT/proxy timeouts). That is a different problem with the same word.

NUMSUB sidesteps all of this: Redis is the source of truth; every query is exact; nothing needs to be kept alive.

### 3.2 Asymmetric TTLs

Symmetric TTL is wrong for this problem because the two cache outcomes have different failure modes:

| Cache says | Reality | Result of staleness |
|---|---|---|
| `true` | Room just emptied | Redundant publish, dropped on the Redis floor — same as no tracker. |
| `false` | Room just gained a subscriber | Real message silently dropped. |

So we cache `true` long (default 30s) and `false` short (default 1s). Local subscribes pre-warm `true` immediately, eliminating the self-join race. The remaining "stale-false" window applies only to remote joins between our cache writes. Same idea as positive/negative TTLs in DNS.

### 3.3 Caching is mandatory, not optional

Trackers are expected to be cheap on average. Querying Redis per publish would defeat the optimisation — we would be trading one round-trip (the publish) for another (the NUMSUB). The default TTLs ensure the steady-state cost of the tracker is near-zero when traffic is regular.

### 3.4 Fail-open on tracker errors

If the tracker throws or rejects, the adapter publishes anyway. Suppressing a publish when uncertain would silently drop legitimate messages — a strictly worse failure mode than today's behaviour (redundant publish).

### 3.5 Adapter layer, not application layer

The presence question requires knowing the channel-name mapping (`channelPrefix + room`). Only the adapter owns that. Pushing presence into application code would force every consumer to re-derive the name and re-maintain bookkeeping the adapter already does on subscribe/unsubscribe — for no architectural benefit.

### 3.6 No `local short-circuit` in `SSERoomManager`

An earlier draft proposed skipping the tracker check when the local node has subscribers (since the publish is going out regardless). Inspection showed the original spec's code did not actually short-circuit anything — both branches called `adapter.publish`. With NUMSUB-cache + eager `notifyLocalSubscribed`, the cache hit for a locally-subscribed room is `true` anyway, so an explicit short-circuit at the manager level is dead weight. Dropped.

### 3.7 Sharded pub/sub as a separate adapter, not a mode flag

The classic and sharded clients have genuinely different types (`RedisClientLike` vs `RedisShardedClientLike`). A mode flag on a single class would require either lying with `any` or branching the public API. Two sibling classes are explicit, type-safe, and let consumers pick deliberately based on their Redis topology.

### 3.8 Two adapters share an internal payload codec, not a base class

The encode/decode of `{ v, m, n, meta? }` lives in `src/internal/payload.ts`. Everything else is duplicated symmetrically across `RedisAdapter` and `RedisShardedAdapter`. The duplication is ~70 lines per adapter — cheaper than the typing gymnastics a shared base class would have required for the divergent client signatures.

---

## 4. Public API

```ts
// Adapters (both accept an optional `presence` config)
new RedisAdapter({ pubClient, subClient, presence?: PresenceTracker })
new RedisShardedAdapter({ pubClient, subClient, presence?: PresenceTracker })

// Bundled trackers (asymmetric-TTL NUMSUB cache)
new NumsubPresenceTracker({ client, channelPrefix?, hasSubscribersTtlMs?, noSubscribersTtlMs?, maxCacheEntries? })
new ShardedNumsubPresenceTracker({ /* same shape */ })

// Custom strategies implement the interface
interface PresenceTracker {
  hasSubscribers(room: string): boolean | Promise<boolean>
  notifyLocalSubscribed?(room: string): void
  notifyLocalUnsubscribed?(room: string): void
  dispose?(): void | Promise<void>
}
```

Re-exports from `@opinionated-machine/sse-rooms-redis/src/index.ts`:

```
RedisAdapter, RedisShardedAdapter
NumsubPresenceTracker, ShardedNumsubPresenceTracker
type PresenceTracker, NumsubCapableClient
type CachedPubsubCountTrackerConfig
type NumsubPresenceTrackerConfig, ShardedNumsubPresenceTrackerConfig
type RedisAdapterConfig, RedisShardedAdapterConfig
type RedisClientLike, RedisShardedClientLike, RedisRoomMessage
```

No breaking changes. Default behaviour with no `presence` config is identical to the previous release.

---

## 5. Wire format

Unchanged: `{ v: 1, m: SSEMessage, n: nodeId, meta?: Record<string, unknown> }`. Both adapters share the codec (`src/internal/payload.ts`). The sharded adapter does NOT introduce a new key pattern in Redis — the SET-based design that would have done so was rejected.

---

## 6. Failure modes

| Scenario | Behaviour |
|---|---|
| `hasSubscribers` throws / rejects | Adapter publishes anyway (fail-open). |
| Tracker cached `false`, remote subscriber appeared moments ago | Publish skipped; one message dropped. Bounded by `noSubscribersTtlMs` (default 1s). |
| Tracker cached `true`, everyone just left | Publish goes through to Redis, drops on the floor. Same as no tracker. |
| Tracker cached `false` for a locally-subscribed room | Cannot happen — local subscribes pre-warm the cache to `true`. |
| Local node loses connection to Redis mid-publish | `pubClient.publish` rejects up to caller (unchanged behaviour). |
| `dispose()` throws on disconnect | Caught by the adapter; does not block `disconnect()`. |

---

## 7. Tests

### Unit tests (no Redis required)
- `src/presence/NumsubPresenceTracker.spec.ts` — cache hit/miss, asymmetric TTL behaviour, LRU eviction and touch, eager subscribe/unsubscribe, dispose, ioredis vs node-redis client compatibility, constructor validation.
- `src/presence/ShardedNumsubPresenceTracker.spec.ts` — sanity check that SHARDNUMSUB is issued and caching is inherited.
- `src/RedisAdapter.spec.ts` — adds presence-tracker integration tests (skip on `false`, publish on `true`, fail-open on throw, eager notification ordering, dispose on disconnect, sync/async hasSubscribers).
- `src/RedisShardedAdapter.spec.ts` — full mirror of `RedisAdapter.spec.ts` coverage for the sibling adapter, plus the same presence-integration cases.

73 unit tests total, all passing.

### Integration tests (require Docker)
- `src/RedisAdapter.integration.spec.ts` — existing cross-node tests plus a new `NumsubPresenceTracker` describe block verifying: publish goes through when a remote subscriber exists, publish is **actually** suppressed when nobody is subscribed (verified by spying on `pubClient.publish`), the positive cache prevents repeat NUMSUB queries, the cache expires after the configured TTL.
- `src/RedisShardedAdapter.integration.spec.ts` — new file. Cross-node tests against a real Redis Cluster (3 masters + 3 replicas via docker-compose): cross-node propagation via SPUBLISH/SSUBSCRIBE, multiple rooms across different shards, SUNSUBSCRIBE behaviour, plus ShardedNumsubPresenceTracker integration tests mirroring the classic ones.

Run with `npm run test:docker`. The cluster service uses `grokzen/redis-cluster:7.2.4` with `natMap` to translate the container's 0.0.0.0 announces to 127.0.0.1.

---

## 8. References

- [Redis Pub/Sub documentation](https://redis.io/docs/latest/develop/pubsub/) — fire-and-forget semantics.
- [PUBSUB NUMSUB](https://redis.io/docs/latest/commands/pubsub-numsub/) — O(N) over the requested channel list.
- [SSUBSCRIBE / SPUBLISH](https://redis.io/docs/latest/commands/ssubscribe/) — sharded pub/sub (Redis 7.0+).
- [Socket.IO scaling issue #5226](https://github.com/socketio/socket.io/issues/5226) — the same problem in the Socket.IO ecosystem; still unresolved.
- [Socket.IO Redis adapter docs](https://socket.io/docs/v4/redis-adapter/) — does not skip publishes.
- [Centrifugo engines and scalability](https://centrifugal.dev/docs/server/engines) — TTL-on-event presence (no heartbeat).
- [Amazon ElastiCache Pub/Sub best practices](https://docs.aws.amazon.com/AmazonElastiCache/latest/red-ug/BestPractices.PubSub.html) — AWS recommendation for sharded pub/sub on Cluster Mode Enabled / Valkey.
- [ElastiCache for Redis 7](https://www.amazonaws.cn/en/new/2022/amazon-elasticache-adds-support-for-redis-7/) — sharded pub/sub on ElastiCache.
- [WebSocket.org heartbeat guide](https://websocket.org/guides/heartbeat/) — heartbeats for connection liveness (different problem from cluster presence).

---

## 9. What was NOT built (and why)

- **Heartbeat-based SET registry.** See §3.1 — duplicates Redis's own subscriber state and requires a background sweeper for crash recovery, neither of which is standard practice for this problem.
- **`PresenceTracker` in the core library.** Concept only applies to multi-node adapters; `InMemoryAdapter` has no use for it. Lives in the Redis package; can be promoted later if a second adapter package needs it.
- **`local short-circuit` in `SSERoomManager`.** As proposed in the original draft it did not actually short-circuit anything. With eager `notifyLocalSubscribed` in the tracker, the cache hit for a locally-subscribed room is already `true`, so the manager-layer check is redundant.
- **Pluggable second tracker (e.g. SET-based).** The interface accepts any implementation, so consumers can ship one if they want it. The package itself ships only the NUMSUB strategy to keep the opinionated default clear.
- **Timeout on `hasSubscribers`.** Implementations are expected to be cheap. A slow tracker is a bug, not a configuration option. Fail-open covers the genuine-error case.
