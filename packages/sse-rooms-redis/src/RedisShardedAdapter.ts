import { randomUUID } from 'node:crypto'
import type { SSEMessage, SSERoomAdapter, SSERoomMessageHandler } from 'opinionated-machine'
import { decodePayload, encodePayload } from './internal/payload.ts'
import type { PresenceTracker } from './presence/types.ts'
import type { RedisShardedAdapterConfig } from './types.ts'

/**
 * Redis sharded Pub/Sub adapter for cross-node SSE room communication on
 * Redis Cluster (or Valkey).
 *
 * Sharded pub/sub (`SPUBLISH` / `SSUBSCRIBE` / `SUNSUBSCRIBE`, introduced in
 * Redis 7.0) hashes the channel name to a slot and scopes propagation to the
 * master + replicas of that shard, rather than broadcasting across the entire
 * cluster bus. For workloads with many sparse channels on a multi-shard
 * cluster this dramatically reduces inter-node traffic.
 *
 * **Requirements:**
 * - A Cluster-aware Redis client (e.g. ioredis `Cluster`, node-redis
 *   `createCluster`).
 * - Two separate cluster connections (pub and sub).
 * - Redis 7.0+ in Cluster Mode, or any Valkey version in Cluster Mode, or
 *   any version of AWS ElastiCache Serverless.
 *
 * **NOT for:**
 * - Standalone Redis or Redis Sentinel — use `RedisAdapter`.
 * - ElastiCache with Cluster Mode Disabled — use `RedisAdapter`.
 *
 * **Message Format:** identical to `RedisAdapter` — `{ v, m, n, meta? }`,
 * see that class for details.
 *
 * @example With ioredis Cluster
 * ```typescript
 * import { Cluster } from 'ioredis'
 * import { RedisShardedAdapter } from '@opinionated-machine/sse-rooms-redis'
 *
 * const nodes = [{ host: 'redis-1', port: 6379 }, { host: 'redis-2', port: 6379 }]
 * const pubClient = new Cluster(nodes)
 * const subClient = new Cluster(nodes)
 *
 * const adapter = new RedisShardedAdapter({ pubClient, subClient })
 * ```
 *
 * @example With presence-aware publishing
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
export class RedisShardedAdapter implements SSERoomAdapter {
  private readonly pubClient: RedisShardedAdapterConfig['pubClient']
  private readonly subClient: RedisShardedAdapterConfig['subClient']
  private readonly channelPrefix: string
  private readonly nodeId: string
  private readonly presence?: PresenceTracker
  private messageHandler?: SSERoomMessageHandler
  private readonly subscribedChannels: Set<string> = new Set()

  constructor(config: RedisShardedAdapterConfig) {
    this.pubClient = config.pubClient
    this.subClient = config.subClient
    this.channelPrefix = config.channelPrefix ?? 'sse:room:'
    this.nodeId = config.nodeId ?? randomUUID()
    this.presence = config.presence
  }

  connect(): Promise<void> {
    this.subClient.on('smessage', (channel: string, message: string) => {
      this.handleMessage(channel, message)
    })
    return Promise.resolve()
  }

  async disconnect(): Promise<void> {
    const channels = Array.from(this.subscribedChannels)
    if (channels.length > 0) {
      await this.subClient.sunsubscribe(...channels)
    }
    this.subscribedChannels.clear()
    await this.presence?.dispose?.()
  }

  async subscribe(room: string): Promise<void> {
    const channel = this.getChannelName(room)
    if (this.subscribedChannels.has(channel)) {
      return
    }

    await this.subClient.ssubscribe(channel)
    this.subscribedChannels.add(channel)
    this.presence?.notifyLocalSubscribed?.(room)
  }

  async unsubscribe(room: string): Promise<void> {
    const channel = this.getChannelName(room)
    if (!this.subscribedChannels.has(channel)) {
      return
    }

    await this.subClient.sunsubscribe(channel)
    this.subscribedChannels.delete(channel)
    this.presence?.notifyLocalUnsubscribed?.(room)
  }

  async publish(
    room: string,
    message: SSEMessage,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    if (this.presence) {
      try {
        const has = await this.presence.hasSubscribers(room)
        if (!has) {
          return
        }
      } catch {
        // Fail-open
      }
    }

    const channel = this.getChannelName(room)
    await this.pubClient.spublish(channel, encodePayload(message, this.nodeId, metadata))
  }

  onMessage(handler: SSERoomMessageHandler): void {
    this.messageHandler = handler
  }

  private getChannelName(room: string): string {
    return `${this.channelPrefix}${room}`
  }

  private getRoomFromChannel(channel: string): string {
    return channel.slice(this.channelPrefix.length)
  }

  private handleMessage(channel: string, rawMessage: string): void {
    if (!this.messageHandler) {
      return
    }

    const decoded = decodePayload(rawMessage)
    if (!decoded) {
      return
    }

    const room = this.getRoomFromChannel(channel)
    const result = this.messageHandler(
      room,
      decoded.message,
      decoded.sourceNodeId,
      decoded.metadata,
    )
    if (result && typeof (result as Promise<void>).catch === 'function') {
      ;(result as Promise<void>).catch(() => {
        // Swallow to prevent unhandled rejection.
      })
    }
  }
}
