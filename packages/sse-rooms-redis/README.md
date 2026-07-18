# @opinionated-machine/sse-rooms-redis

Redis Pub/Sub adapter for SSE rooms in [opinionated-machine](https://github.com/kibertoad/opinionated-machine).

This package enables cross-node room broadcasting for SSE connections in multi-server deployments using Redis Pub/Sub.

Two adapters, pick by topology:

| Adapter | Underlying commands | Use with |
|---|---|---|
| `RedisAdapter` | `SUBSCRIBE` / `UNSUBSCRIBE` / `PUBLISH` | Standalone Redis, Redis Sentinel, ElastiCache (Cluster Mode Disabled) |
| `RedisShardedAdapter` | `SSUBSCRIBE` / `SUNSUBSCRIBE` / `SPUBLISH` (Redis 7.0+) | Redis Cluster, Valkey, ElastiCache (Cluster Mode Enabled), ElastiCache Serverless |

Both adapters also accept an optional, opt-in presence tracker that can skip publishes for rooms with no subscribers anywhere — narrow applicability, see [TRACKER.md](./TRACKER.md) before enabling.

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

## Presence-Aware Publishing (Optional)

Both adapters accept an optional `presence` config that skips `PUBLISH` / `SPUBLISH` when no node in the cluster has a subscriber. The two bundled trackers query Redis via `PUBSUB NUMSUB` / `PUBSUB SHARDNUMSUB` with cached results.

**Default recommendation: do not enable.** The optimisation is narrow — break-even is roughly 2 publishes per second to the same empty room, below which the NUMSUB query you pay roughly equals the PUBLISH you avoid. Enable only after measuring a workload that clears that bar (heartbeat-style fanouts, bursty rebroadcasts).

See **[TRACKER.md](./TRACKER.md)** for the full picture: break-even analysis, when to use vs not, configuration, failure modes, observability (`onPresenceError`), custom trackers, and design rationale.

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
