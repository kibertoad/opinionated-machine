import { connect, type Socket } from 'node:net'
import { Cluster } from 'ioredis'
import type { SSEMessage } from 'opinionated-machine'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ShardedNumsubPresenceTracker } from './presence/ShardedNumsubPresenceTracker.ts'
import { RedisShardedAdapter } from './RedisShardedAdapter.ts'
import type { RedisShardedClientLike } from './types.ts'

/**
 * Integration tests for RedisShardedAdapter against a real Redis Cluster.
 *
 * Requires a multi-node Redis Cluster reachable on 127.0.0.1:7000-7005.
 * Run with: npm run test:docker (the cluster service is in docker-compose.yml).
 *
 * NOTE: ioredis Cluster announces its nodes by the IP they advertise to other
 * cluster members. The grokzen docker image announces 0.0.0.0 because it does
 * not know its externally-routable hostname; we translate via natMap.
 */
const CLUSTER_NODES = [
  { host: '127.0.0.1', port: 7000 },
  { host: '127.0.0.1', port: 7001 },
  { host: '127.0.0.1', port: 7002 },
]

const NAT_MAP = {
  '0.0.0.0:7000': { host: '127.0.0.1', port: 7000 },
  '0.0.0.0:7001': { host: '127.0.0.1', port: 7001 },
  '0.0.0.0:7002': { host: '127.0.0.1', port: 7002 },
  '0.0.0.0:7003': { host: '127.0.0.1', port: 7003 },
  '0.0.0.0:7004': { host: '127.0.0.1', port: 7004 },
  '0.0.0.0:7005': { host: '127.0.0.1', port: 7005 },
}

function makeCluster(): Cluster {
  return new Cluster(CLUSTER_NODES, {
    natMap: NAT_MAP,
    lazyConnect: true,
    redisOptions: { lazyConnect: true },
  })
}

/**
 * Probe the first cluster node with a short-timeout TCP connect. We use the
 * result to skip the entire suite gracefully when no cluster is reachable —
 * CI runs against standalone Redis only, so without this gate the suite
 * fails at `beforeAll` instead of skipping. Locally, `npm run test:docker`
 * brings the cluster up before tests run.
 */
function probeCluster(host: string, port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false
    let socket: Socket | undefined
    const finish = (result: boolean) => {
      if (settled) return
      settled = true
      socket?.removeAllListeners()
      socket?.destroy()
      resolve(result)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    socket = connect({ host, port })
    socket.once('connect', () => {
      clearTimeout(timer)
      finish(true)
    })
    socket.once('error', () => {
      clearTimeout(timer)
      finish(false)
    })
  })
}

const CLUSTER_AVAILABLE = await probeCluster(CLUSTER_NODES[0]!.host, CLUSTER_NODES[0]!.port)

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for predicate after ${timeoutMs}ms`)
    }
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe.skipIf(!CLUSTER_AVAILABLE)('RedisShardedAdapter Integration', () => {
  let pubClient1: Cluster
  let subClient1: Cluster
  let pubClient2: Cluster
  let subClient2: Cluster

  beforeAll(async () => {
    pubClient1 = makeCluster()
    subClient1 = makeCluster()
    pubClient2 = makeCluster()
    subClient2 = makeCluster()

    await Promise.all([
      pubClient1.connect(),
      subClient1.connect(),
      pubClient2.connect(),
      subClient2.connect(),
    ])
  }, 30_000)

  afterAll(async () => {
    await Promise.all([pubClient1.quit(), subClient1.quit(), pubClient2.quit(), subClient2.quit()])
  })

  describe('cross-node sharded pub/sub', () => {
    let adapter1: RedisShardedAdapter
    let adapter2: RedisShardedAdapter

    beforeEach(async () => {
      adapter1 = new RedisShardedAdapter({
        pubClient: pubClient1 as unknown as RedisShardedClientLike,
        subClient: subClient1 as unknown as RedisShardedClientLike,
        nodeId: 'node-1',
        channelPrefix: 'test:sharded:',
      })
      adapter2 = new RedisShardedAdapter({
        pubClient: pubClient2 as unknown as RedisShardedClientLike,
        subClient: subClient2 as unknown as RedisShardedClientLike,
        nodeId: 'node-2',
        channelPrefix: 'test:sharded:',
      })

      await adapter1.connect()
      await adapter2.connect()
    })

    afterEach(async () => {
      await adapter1.disconnect()
      await adapter2.disconnect()
    })

    it('propagates messages between nodes via SPUBLISH/SSUBSCRIBE', async () => {
      const received: Array<{ room: string; message: SSEMessage; sourceNodeId: string }> = []
      adapter2.onMessage((room: string, message: SSEMessage, sourceNodeId: string) => {
        received.push({ room, message, sourceNodeId })
      })

      await adapter2.subscribe('test-room')
      // SSUBSCRIBE needs a moment to register with the owning shard.
      await new Promise((r) => setTimeout(r, 200))

      await adapter1.publish('test-room', {
        event: 'chat',
        data: { text: 'sharded hello' },
      })

      await waitFor(() => received.length > 0)
      expect(received[0]).toMatchObject({
        room: 'test-room',
        message: { event: 'chat', data: { text: 'sharded hello' } },
        sourceNodeId: 'node-1',
      })
    })

    it('handles multiple rooms across (likely different) shards', async () => {
      const received: string[] = []
      adapter2.onMessage((room: string) => {
        received.push(room)
      })

      // These room names are deliberately different so they hash to different
      // slots — sharded pub/sub routes each to its own shard.
      await adapter2.subscribe('room-alpha')
      await adapter2.subscribe('room-bravo')
      await new Promise((r) => setTimeout(r, 200))

      await adapter1.publish('room-alpha', { event: 'a', data: {} })
      await adapter1.publish('room-bravo', { event: 'b', data: {} })
      await adapter1.publish('room-charlie', { event: 'c', data: {} }) // not subscribed

      await waitFor(() => received.length >= 2)
      expect(received).toContain('room-alpha')
      expect(received).toContain('room-bravo')
      expect(received).not.toContain('room-charlie')
    })

    it('stops delivering after SUNSUBSCRIBE', async () => {
      const received: string[] = []
      adapter2.onMessage((room: string) => {
        received.push(room)
      })

      await adapter2.subscribe('ephemeral')
      await new Promise((r) => setTimeout(r, 200))

      await adapter1.publish('ephemeral', { event: 'first', data: {} })
      await waitFor(() => received.length === 1)

      await adapter2.unsubscribe('ephemeral')
      // SUNSUBSCRIBE propagates within the shard.
      await new Promise((r) => setTimeout(r, 200))

      await adapter1.publish('ephemeral', { event: 'second', data: {} })
      // Give the message a chance to (not) arrive.
      await new Promise((r) => setTimeout(r, 200))

      expect(received).toHaveLength(1)
    })
  })

  describe('with ShardedNumsubPresenceTracker', () => {
    let adapter1: RedisShardedAdapter
    let adapter2: RedisShardedAdapter
    let publishSpy: ReturnType<typeof vi.spyOn>

    beforeEach(async () => {
      adapter1 = new RedisShardedAdapter({
        pubClient: pubClient1 as unknown as RedisShardedClientLike,
        subClient: subClient1 as unknown as RedisShardedClientLike,
        nodeId: 'node-1',
        channelPrefix: 'test:shardedpresence:',
      })
      adapter2 = new RedisShardedAdapter({
        pubClient: pubClient2 as unknown as RedisShardedClientLike,
        subClient: subClient2 as unknown as RedisShardedClientLike,
        nodeId: 'node-2',
        channelPrefix: 'test:shardedpresence:',
        presence: new ShardedNumsubPresenceTracker({
          // Cast through unknown since ioredis Cluster types don't directly
          // match NumsubCapableClient, but `.call` is available at runtime.
          client: pubClient2 as unknown as {
            call(command: string, ...args: string[]): Promise<unknown>
          },
          channelPrefix: 'test:shardedpresence:',
          hasSubscribersTtlMs: 200,
          noSubscribersTtlMs: 100,
        }),
      })

      publishSpy = vi.spyOn(pubClient2, 'spublish')

      await adapter1.connect()
      await adapter2.connect()
    })

    afterEach(async () => {
      publishSpy.mockRestore()
      await adapter1.disconnect()
      await adapter2.disconnect()
    })

    it('publishes when a remote node is subscribed', async () => {
      const received: string[] = []
      adapter1.onMessage((room: string) => {
        received.push(room)
      })

      await adapter1.subscribe('shard-active')
      await new Promise((r) => setTimeout(r, 200))

      await adapter2.publish('shard-active', { event: 'e', data: {} })
      await waitFor(() => received.length > 0)

      expect(publishSpy).toHaveBeenCalledTimes(1)
    })

    it('skips SPUBLISH when no node is subscribed', async () => {
      await adapter2.publish('shard-empty', { event: 'e', data: {} })
      await new Promise((r) => setTimeout(r, 100))

      expect(publishSpy).not.toHaveBeenCalled()
    })
  })
})
