# @opinionated-machine/sse-rooms-redis

Redis Pub/Sub adapter for SSE rooms in [opinionated-machine](https://github.com/kibertoad/opinionated-machine).

This package enables cross-node room broadcasting for SSE connections in multi-server deployments using Redis Pub/Sub.

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
  constructor(deps: { redisUrl: string }) {
    const pubClient = createClient({ url: deps.redisUrl })
    const subClient = pubClient.duplicate()

    // node-redis requires explicit connect
    pubClient.connect()
    subClient.connect()

    super(deps, {
      rooms: {
        adapter: new RedisAdapter({ pubClient, subClient })
      }
    })
  }
}
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
  e?: string,        // Except connection ID (optional)
  n: string          // Source node ID
}
```

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
