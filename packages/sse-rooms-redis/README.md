# @opinionated-machine/sse-rooms-redis

Redis Pub/Sub adapter for SSE rooms in [opinionated-machine](https://github.com/kibertoad/opinionated-machine).

This package enables cross-node room broadcasting for SSE connections in multi-server deployments using Redis Pub/Sub.

It ships two adapters plus an optional presence-tracking layer:

| Adapter | Underlying commands | Use with |
|---|---|---|
| `RedisAdapter` | `SUBSCRIBE` / `UNSUBSCRIBE` / `PUBLISH` | Standalone Redis, Redis Sentinel, ElastiCache (Cluster Mode Disabled) |
| `RedisShardedAdapter` | `SSUBSCRIBE` / `SUNSUBSCRIBE` / `SPUBLISH` (Redis 7.0+) | Redis Cluster, Valkey, ElastiCache (Cluster Mode Enabled), ElastiCache Serverless |

Both adapters accept an optional `presence` tracker that skips publishes for rooms with no subscribers anywhere in the cluster. See [Presence-Aware Publishing](#presence-aware-publishing).

## Installation

```bash
npm install @opinionated-machine/sse-rooms-redis
```

## Requirements

- Redis 2.0+ (for pub/sub support)
- A Redis client library compatible with the `RedisClientLike` interface (e.g., `ioredis`, `redis`)
- Two separate Redis connections (one for publishing, one for subscribing)

## Usage

### With ioredis

```typescript
import Redis from 'ioredis'
import { RedisAdapter } from '@opinionated-machine/sse-rooms-redis'
import { AbstractSSEController } from 'opinionated-machine'

class ChatSSEController extends AbstractSSEController<typeof contracts> {
  constructor(deps: { redis: Redis }) {
    // IMPORTANT: Subscriber client must be a separate connection
    const pubClient = deps.redis
    const subClient = deps.redis.duplicate()

    super(deps, {
      rooms: {
        adapter: new RedisAdapter({ pubClient, subClient })
      }
    })
  }

  // ... handler code
}
```

### With node-redis

```typescript
import { createClient } from 'redis'
import { RedisAdapter } from '@opinionated-machine/sse-rooms-redis'
import { AbstractSSEController } from 'opinionated-machine'

class ChatSSEController extends AbstractSSEController<typeof contracts> {
  constructor(deps: { pubClient: ReturnType<typeof createClient>; subClient: ReturnType<typeof createClient> }) {
    super(deps, {
      rooms: {
        adapter: new RedisAdapter({ pubClient: deps.pubClient, subClient: deps.subClient })
      }
    })
  }
}

// Setup (before creating controller):
const pubClient = createClient({ url: redisUrl })
const subClient = pubClient.duplicate()

// node-redis requires explicit connect - await both before use
await Promise.all([pubClient.connect(), subClient.connect()])
```

## Configuration

```typescript
type RedisAdapterConfig = {
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
```

## How It Works

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Redis Pub/Sub                            │
└────────────────────────────┬────────────────────────────────┘
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
   ┌────▼────┐          ┌────▼────┐          ┌────▼────┐
   │  Node 1 │          │  Node 2 │          │  Node N │
   │ Adapter │          │ Adapter │          │ Adapter │
   └────┬────┘          └────┬────┘          └────┬────┘
        │                    │                    │
   connections          connections          connections
```

### Message Flow

1. **Local Broadcast**: When `broadcastToRoom()` is called, the message is first sent to all local connections in the room.

2. **Redis Publish**: The message is then published to a Redis channel named `{prefix}{roomName}`.

3. **Cross-Node Delivery**: Other nodes subscribed to the channel receive the message via their subscriber client.

4. **Remote Broadcast**: Each node forwards the message to its local connections in the room.

### Message Format

Messages are JSON-encoded with the following structure:

```typescript
{
  v: 1,              // Protocol version
  m: {               // SSE message
    event: string,
    data: unknown,
    id?: string,
    retry?: number
  },
  n: string          // Source node ID
}
```

## Sharded Pub/Sub for Redis Cluster

For deployments on Redis Cluster (Redis 7.0+), Valkey, or AWS ElastiCache with Cluster Mode Enabled, use `RedisShardedAdapter` instead of `RedisAdapter`. Sharded pub/sub (`SPUBLISH` / `SSUBSCRIBE`) hashes each channel name to a single slot and confines message propagation to that shard, rather than broadcasting across the entire cluster bus the way classic pub/sub does. For workloads with many sparse channels on a multi-shard cluster this dramatically reduces inter-node traffic — AWS explicitly recommends it for high-throughput pub/sub workloads.

```typescript
import { Cluster } from 'ioredis'
import { RedisShardedAdapter } from '@opinionated-machine/sse-rooms-redis'

const nodes = [{ host: 'redis-1', port: 6379 }, { host: 'redis-2', port: 6379 }]
const pubClient = new Cluster(nodes)
const subClient = new Cluster(nodes)

const adapter = new RedisShardedAdapter({ pubClient, subClient })
```

**When to use which adapter:**

| Deployment | Adapter |
|---|---|
| Self-hosted single Redis | `RedisAdapter` |
| Self-hosted Redis Sentinel | `RedisAdapter` |
| Self-hosted Redis Cluster (>= 7.0) | `RedisShardedAdapter` |
| Self-hosted Valkey Cluster | `RedisShardedAdapter` |
| AWS ElastiCache for Redis OSS, Cluster Mode Disabled | `RedisAdapter` |
| AWS ElastiCache for Redis OSS 7+, Cluster Mode Enabled | `RedisShardedAdapter` |
| AWS ElastiCache for Valkey, Cluster Mode Disabled | `RedisAdapter` |
| AWS ElastiCache for Valkey, Cluster Mode Enabled | `RedisShardedAdapter` |
| AWS ElastiCache Serverless | `RedisShardedAdapter` (it rewrites classic commands to sharded internally — using the sharded adapter avoids the translation overhead) |

If you are unsure: classic pub/sub works everywhere, sharded pub/sub does not. Start with `RedisAdapter` and migrate to `RedisShardedAdapter` if you move to Cluster Mode.

### Sharded Pub/Sub Caveats

- **No pattern subscriptions.** `SSUBSCRIBE` does not support `PSUBSCRIBE` patterns. This adapter never uses patterns, so it is unaffected — but custom subscribers on the same channels cannot use `PSUBSCRIBE` either.
- **Client must be Cluster-aware.** Pass an `ioredis.Cluster` or `node-redis` `createCluster` client. Standalone clients will not route `SPUBLISH` correctly.

## Presence-Aware Publishing

By default every call to `adapter.publish(room, message)` results in a `PUBLISH` (or `SPUBLISH`) to Redis, even when no node in the cluster has a subscriber for the room — Redis drops the message on the floor, but the publisher still pays one round-trip per call. For workloads that fan out many per-user / per-team notifications to mostly-offline rooms (e.g. SSE-backed notification streams), this is wasted work.

Both adapters accept an optional `presence` config: a `PresenceTracker` consulted before each publish. If the tracker reports no subscribers anywhere, the underlying `PUBLISH` / `SPUBLISH` is skipped. If the tracker errors, the publish goes through anyway (fail-open — never silently drop a real message).

Two bundled trackers query Redis directly for subscriber counts and cache the result with asymmetric TTLs (long for "yes, has subscribers", short for "no") so the optimisation does not cost a round-trip per publish.

### NumsubPresenceTracker (classic pub/sub)

Uses `PUBSUB NUMSUB`. Pair with `RedisAdapter`.

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

### ShardedNumsubPresenceTracker (sharded pub/sub)

Uses `PUBSUB SHARDNUMSUB`. Pair with `RedisShardedAdapter`.

```typescript
import { Cluster } from 'ioredis'
import {
  RedisShardedAdapter,
  ShardedNumsubPresenceTracker,
} from '@opinionated-machine/sse-rooms-redis'

const pubClient = new Cluster([{ host: 'redis-cluster', port: 6379 }])
const subClient = new Cluster([{ host: 'redis-cluster', port: 6379 }])

const adapter = new RedisShardedAdapter({
  pubClient,
  subClient,
  presence: new ShardedNumsubPresenceTracker({ client: pubClient }),
})
```

### Tracker Configuration

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

Local subscribes pre-warm the tracker's cache to `true` (so the adapter never asks Redis about a room you just joined), and local unsubscribes invalidate the entry. The remaining "stale-false" risk is bounded to `noSubscribersTtlMs` after a *remote* node joins a room your node is publishing to.

### Failure Modes

| Scenario | Behaviour |
|---|---|
| `hasSubscribers` throws | Adapter publishes anyway (fail-open). |
| Tracker says `false` but a remote subscriber appeared moments ago | Publish skipped; one message lost. Bounded by `noSubscribersTtlMs`. |
| Tracker says `true` but everyone just left | Publish goes through to Redis, which drops it. Same as today's behaviour. |
| Tracker says `false` for a room with a *local* subscriber | Cannot happen — local subscribes pre-warm the cache to `true`. |

### Custom Trackers

Implement the `PresenceTracker` interface if you want a different strategy (e.g. a registry maintained at the application layer, or an external presence service):

```typescript
import type { PresenceTracker } from '@opinionated-machine/sse-rooms-redis'

class MyPresenceTracker implements PresenceTracker {
  async hasSubscribers(room: string): Promise<boolean> {
    // your logic
  }

  notifyLocalSubscribed?(room: string): void { /* optional */ }
  notifyLocalUnsubscribed?(room: string): void { /* optional */ }
  dispose?(): void | Promise<void> { /* optional */ }
}
```

### Design Rationale

The presence tracker design went through a few iterations before landing here. The short version: **Redis already tracks cluster-wide subscriber state authoritatively via pub/sub. Our job is to query it cheaply, not to duplicate it.** Everything below follows from that.

#### Why NUMSUB and not a SET-based registry

An obvious alternative is to maintain a Redis SET per room (`<prefix>presence:<room>` → set of node IDs), populated via `SADD` / `SREM` on local subscribe / unsubscribe. The publisher checks `SCARD` before publishing. This is what the Socket.IO ecosystem occasionally reaches for, and an early draft of this work used it.

The problems:

1. **It duplicates state Redis already maintains.** `PUBSUB NUMSUB` is exact, real-time, and free of the consistency issues a registry creates. A SET-based registry is a denormalised cache of the authoritative subscriber list — and any denormalised cache eventually diverges.
2. **Node-crash recovery requires a heartbeat.** If a node dies without running its `SREM`, its entry sticks in the SET forever and `SCARD > 0` always returns true. The standard mitigation is a periodic re-`SADD` with a TTL applied per heartbeat. At 10k rooms × 15s intervals that is ~667 background ops/sec just maintaining presence — a cost that scales with room count rather than publish rate.
3. **Heartbeats are not standard practice for this problem.** They are well established for *connection liveness* (WebSocket ping/pong, [WebSocket.org heartbeat guide](https://websocket.org/guides/heartbeat/)) — that is, deciding whether a single TCP connection is dead. Distributed pub/sub presence registries are a different problem with a different shape. Centrifugo, which has the most production-hardened OSS presence implementation we found, uses TTL-on-event (refresh entries when something changes) rather than a background heartbeat ([Centrifugo engines and scalability](https://centrifugal.dev/docs/server/engines)).
4. **The official Socket.IO Redis adapter does not skip publishes either.** The exact "most fanouts hit empty rooms" scaling problem is filed as an unresolved feature request ([Issue #5226](https://github.com/socketio/socket.io/issues/5226)) — the discussion focuses on subscription patterns and Redis sharded pub/sub, not on application-level registries.

NUMSUB inverts all of this: Redis is the source of truth, every read is exact, and there is nothing to keep alive between reads.

#### Why asymmetric TTLs

A naive cache uses one TTL for both answers. That is wrong for this problem: the two answers have very different failure modes.

| Cache says | Reality | Result of staleness |
|---|---|---|
| `hasSubscribers = true` | Room just emptied | One `PUBLISH` hits zero subscribers. Redis drops it. **Identical to having no tracker at all.** |
| `hasSubscribers = false` | Room just gained a subscriber | One real message is **silently dropped.** Bad. |

So we cache "yes" comfortably long (default 30s) and "no" tightly (default 1s). Local subscribes pre-warm the cache to `true` immediately, eliminating the "stale-false" risk for self-initiated joins; the remaining window where it matters is a *remote* node joining a room our node is publishing to.

This is the same idea as positive/negative TTLs in DNS — different consequences of staleness deserve different caching.

#### Why no separate "presence channel" or out-of-band registry

Both add a second source of truth that the application has to keep in sync with the first. NUMSUB queries the source of truth directly. Centrifugo's TTL-on-event approach is similar in spirit — refresh state when state changes, do not maintain a background sweeper.

#### Why this lives at the adapter layer

The only component that knows the channel-name mapping is the adapter. Pushing presence into application code would force every consumer to re-derive the channel name and re-maintain bookkeeping the adapter already does on the subscribe/unsubscribe path. Pushing it into the core library would force `InMemoryAdapter` (single-node, where the optimisation is meaningless) to carry the concept too. The adapter is the right level.

#### Why fail-open

Skipping a publish when uncertain would silently drop legitimate messages — a much worse failure mode than the redundant publish today. So when the tracker throws or rejects, the adapter publishes anyway. The optimisation is "skip *known* no-op publishes," never "skip *possibly* legitimate ones."

#### Why pair this with sharded pub/sub (for Cluster Mode)

The two optimisations target different costs:

- **NUMSUB cache** eliminates the publisher's round-trip when nobody is subscribed.
- **Sharded pub/sub** eliminates the cluster-bus fanout when the message is published.

On standalone Redis, only the first matters (there is no cluster bus). On Redis Cluster they stack — and AWS [explicitly recommends sharded pub/sub](https://docs.aws.amazon.com/AmazonElastiCache/latest/red-ug/BestPractices.PubSub.html) for high-throughput workloads on ElastiCache Cluster Mode Enabled and Valkey. ElastiCache Serverless already rewrites classic `PUBLISH` to `SPUBLISH` internally, so using the sharded adapter directly avoids the translation overhead.

#### References

- [Redis Pub/Sub documentation](https://redis.io/docs/latest/develop/pubsub/) — fire-and-forget semantics; messages to channels with no subscribers are dropped.
- [PUBSUB NUMSUB](https://redis.io/docs/latest/commands/pubsub-numsub/) — O(N) over the requested channel list. We query one channel per cache-miss.
- [Socket.IO scaling issue #5226](https://github.com/socketio/socket.io/issues/5226) — the same problem in the Socket.IO ecosystem, still unresolved.
- [Socket.IO Redis adapter](https://socket.io/docs/v4/redis-adapter/) — the dominant reference implementation; does not skip publishes.
- [Centrifugo engines and scalability](https://centrifugal.dev/docs/server/engines) — production presence implementation that uses TTL-on-event rather than heartbeats.
- [SSUBSCRIBE / SPUBLISH](https://redis.io/docs/latest/commands/ssubscribe/) — Redis 7.0 sharded pub/sub.
- [Amazon ElastiCache Pub/Sub best practices](https://docs.aws.amazon.com/AmazonElastiCache/latest/red-ug/BestPractices.PubSub.html) — AWS recommendation to use sharded pub/sub for high-throughput on Cluster Mode Enabled / Valkey.
- [WebSocket.org heartbeat guide](https://websocket.org/guides/heartbeat/) — heartbeats are the right tool for *connection* liveness, which is a different problem than cluster-wide subscriber presence.

## Pub/Sub vs Streams

This adapter uses **Redis Pub/Sub** (not Redis Streams). This is intentional:

| Aspect | Pub/Sub | Streams |
|--------|---------|---------|
| Delivery | Fire-and-forget | Durable with acknowledgment |
| Persistence | None | Messages persist until consumed |
| Use case | Real-time broadcasts | Message queues, reliable delivery |
| Complexity | Simple | Consumer groups, message IDs |

**Why Pub/Sub is appropriate for SSE rooms:**

1. **Real-time nature**: SSE room broadcasts are transient events. If a node is down, it has no clients to forward messages to anyway.

2. **Socket.IO precedent**: The official Socket.IO Redis adapter uses the same Pub/Sub approach.

3. **Simplicity**: No need for message acknowledgment, cleanup, or consumer group management.

**If you need durable messaging** (e.g., offline message queuing), handle that at a different layer with a proper message queue and delivery service.

## Why Two Redis Connections?

Redis clients in subscriber mode (`SUBSCRIBE` command) can only receive messages - they cannot execute other commands like `PUBLISH`. This is a Redis limitation, not a library limitation.

From the [Redis documentation](https://redis.io/commands/subscribe/):

> Once the client enters the subscribed state it is not supposed to issue any other commands, except for additional SUBSCRIBE, SSUBSCRIBE, PSUBSCRIBE, UNSUBSCRIBE, SUNSUBSCRIBE, PUNSUBSCRIBE, PING, RESET and QUIT commands.

## Testing

### Unit Tests

```bash
npm run test:unit
```

### Integration Tests (requires Docker)

```bash
# Start Redis, run tests, stop Redis
npm run test:docker

# Or manually:
npm run docker:up
npm run test:integration
npm run docker:down
```

## License

MIT
