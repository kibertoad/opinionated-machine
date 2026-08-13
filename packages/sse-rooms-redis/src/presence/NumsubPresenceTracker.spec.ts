import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NumsubPresenceTracker } from './NumsubPresenceTracker.ts'
import type { NumsubCapableClient } from './types.ts'

// Intersect the function signature (so the mock satisfies NumsubCapableClient)
// with Mock (so .mockResolvedValue / .mockImplementation are available).
type MockedCall = NonNullable<NumsubCapableClient['call']> & ReturnType<typeof vi.fn>
type MockedSendCommand = NonNullable<NumsubCapableClient['sendCommand']> & ReturnType<typeof vi.fn>

type IoredisStyleMock = { call: MockedCall }
type NodeRedisStyleMock = { sendCommand: MockedSendCommand }

function makeIoredisClient(): IoredisStyleMock {
  return { call: vi.fn() as MockedCall }
}

function makeNodeRedisClient(): NodeRedisStyleMock {
  return { sendCommand: vi.fn() as MockedSendCommand }
}

describe('NumsubPresenceTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('constructor', () => {
    it('throws when neither call nor sendCommand is available', () => {
      expect(() => new NumsubPresenceTracker({ client: {} })).toThrow(
        /`call` \(ioredis\) or `sendCommand` \(node-redis\)/,
      )
    })

    it('accepts an ioredis-style client (call)', () => {
      const client = makeIoredisClient()
      expect(() => new NumsubPresenceTracker({ client })).not.toThrow()
    })

    it('accepts a node-redis-style client (sendCommand)', () => {
      const client = makeNodeRedisClient()
      expect(() => new NumsubPresenceTracker({ client })).not.toThrow()
    })
  })

  describe('hasSubscribers via ioredis call', () => {
    it('returns true when NUMSUB reports count > 0', async () => {
      const client = makeIoredisClient()
      client.call.mockResolvedValue(['sse:room:room-a', 2])
      const tracker = new NumsubPresenceTracker({ client })

      const result = await tracker.hasSubscribers('room-a')

      expect(result).toBe(true)
      expect(client.call).toHaveBeenCalledWith('PUBSUB', 'NUMSUB', 'sse:room:room-a')
    })

    it('returns false when NUMSUB reports count = 0', async () => {
      const client = makeIoredisClient()
      client.call.mockResolvedValue(['sse:room:room-a', 0])
      const tracker = new NumsubPresenceTracker({ client })

      const result = await tracker.hasSubscribers('room-a')

      expect(result).toBe(false)
    })

    it('uses the configured channel prefix', async () => {
      const client = makeIoredisClient()
      client.call.mockResolvedValue(['custom:room-a', 1])
      const tracker = new NumsubPresenceTracker({ client, channelPrefix: 'custom:' })

      await tracker.hasSubscribers('room-a')

      expect(client.call).toHaveBeenCalledWith('PUBSUB', 'NUMSUB', 'custom:room-a')
    })
  })

  describe('hasSubscribers via node-redis sendCommand', () => {
    it('issues PUBSUB NUMSUB via sendCommand with array args', async () => {
      const client = makeNodeRedisClient()
      client.sendCommand.mockResolvedValue(['sse:room:room-a', 3])
      const tracker = new NumsubPresenceTracker({ client })

      const result = await tracker.hasSubscribers('room-a')

      expect(result).toBe(true)
      expect(client.sendCommand).toHaveBeenCalledWith(['PUBSUB', 'NUMSUB', 'sse:room:room-a'])
    })
  })

  describe('caching', () => {
    it('serves a cached true within hasSubscribersTtlMs without re-querying', async () => {
      const client = makeIoredisClient()
      client.call.mockResolvedValue(['sse:room:room-a', 1])
      const tracker = new NumsubPresenceTracker({
        client,
        hasSubscribersTtlMs: 30_000,
      })

      await tracker.hasSubscribers('room-a')
      vi.advanceTimersByTime(29_000)
      const result = await tracker.hasSubscribers('room-a')

      expect(result).toBe(true)
      expect(client.call).toHaveBeenCalledTimes(1)
    })

    it('re-queries after hasSubscribersTtlMs expires', async () => {
      const client = makeIoredisClient()
      client.call.mockResolvedValue(['sse:room:room-a', 1])
      const tracker = new NumsubPresenceTracker({ client, hasSubscribersTtlMs: 30_000 })

      await tracker.hasSubscribers('room-a')
      vi.advanceTimersByTime(30_001)
      await tracker.hasSubscribers('room-a')

      expect(client.call).toHaveBeenCalledTimes(2)
    })

    it('serves a cached false within noSubscribersTtlMs without re-querying', async () => {
      const client = makeIoredisClient()
      client.call.mockResolvedValue(['sse:room:room-a', 0])
      const tracker = new NumsubPresenceTracker({ client, noSubscribersTtlMs: 1_000 })

      await tracker.hasSubscribers('room-a')
      vi.advanceTimersByTime(500)
      const result = await tracker.hasSubscribers('room-a')

      expect(result).toBe(false)
      expect(client.call).toHaveBeenCalledTimes(1)
    })

    it('re-queries after noSubscribersTtlMs expires', async () => {
      const client = makeIoredisClient()
      client.call.mockResolvedValue(['sse:room:room-a', 0])
      const tracker = new NumsubPresenceTracker({ client, noSubscribersTtlMs: 1_000 })

      await tracker.hasSubscribers('room-a')
      vi.advanceTimersByTime(1_001)
      await tracker.hasSubscribers('room-a')

      expect(client.call).toHaveBeenCalledTimes(2)
    })

    it('uses asymmetric TTLs — short TTL for false does not expire a cached true early', async () => {
      const client = makeIoredisClient()
      client.call.mockResolvedValue(['sse:room:room-a', 5])
      const tracker = new NumsubPresenceTracker({
        client,
        hasSubscribersTtlMs: 30_000,
        noSubscribersTtlMs: 1_000,
      })

      await tracker.hasSubscribers('room-a')
      // Past the short TTL but well under the long TTL.
      vi.advanceTimersByTime(5_000)
      await tracker.hasSubscribers('room-a')

      expect(client.call).toHaveBeenCalledTimes(1)
    })
  })

  describe('notifyLocalSubscribed', () => {
    it('pre-warms the cache so the next publish does not query Redis', async () => {
      const client = makeIoredisClient()
      const tracker = new NumsubPresenceTracker({ client })

      tracker.notifyLocalSubscribed('room-a')
      const result = await tracker.hasSubscribers('room-a')

      expect(result).toBe(true)
      expect(client.call).not.toHaveBeenCalled()
    })
  })

  describe('notifyLocalUnsubscribed', () => {
    it('invalidates the cache entry so the next publish re-queries', async () => {
      const client = makeIoredisClient()
      client.call.mockResolvedValue(['sse:room:room-a', 1])
      const tracker = new NumsubPresenceTracker({ client })

      await tracker.hasSubscribers('room-a')
      tracker.notifyLocalUnsubscribed('room-a')
      await tracker.hasSubscribers('room-a')

      expect(client.call).toHaveBeenCalledTimes(2)
    })
  })

  describe('LRU eviction', () => {
    it('evicts the oldest entry when maxCacheEntries is exceeded', async () => {
      const client = makeIoredisClient()
      // Each room reports a different count, but every count > 0.
      client.call.mockImplementation((...args: string[]) => {
        const channel = args[2]!
        return Promise.resolve([channel, 1])
      })
      const tracker = new NumsubPresenceTracker({
        client,
        maxCacheEntries: 2,
        hasSubscribersTtlMs: 60_000,
      })

      await tracker.hasSubscribers('room-1') // miss -> 1 call
      await tracker.hasSubscribers('room-2') // miss -> 2 calls
      await tracker.hasSubscribers('room-3') // miss + evicts room-1 -> 3 calls

      // room-2 still cached
      await tracker.hasSubscribers('room-2')
      expect(client.call).toHaveBeenCalledTimes(3)

      // room-1 was evicted; querying it re-hits Redis.
      await tracker.hasSubscribers('room-1')
      expect(client.call).toHaveBeenCalledTimes(4)
    })

    it('touches an entry on hit so it moves to the end of the LRU', async () => {
      const client = makeIoredisClient()
      client.call.mockImplementation((...args: string[]) => {
        const channel = args[2]!
        return Promise.resolve([channel, 1])
      })
      const tracker = new NumsubPresenceTracker({
        client,
        maxCacheEntries: 2,
        hasSubscribersTtlMs: 60_000,
      })

      await tracker.hasSubscribers('room-1') // 1
      await tracker.hasSubscribers('room-2') // 2
      // Touch room-1, making room-2 the oldest.
      await tracker.hasSubscribers('room-1')
      // Insert room-3 — evicts room-2 (now oldest), keeps room-1.
      await tracker.hasSubscribers('room-3') // 3

      // room-1 still cached
      await tracker.hasSubscribers('room-1')
      expect(client.call).toHaveBeenCalledTimes(3)
    })
  })

  describe('dispose', () => {
    it('clears the cache', async () => {
      const client = makeIoredisClient()
      client.call.mockResolvedValue(['sse:room:room-a', 1])
      const tracker = new NumsubPresenceTracker({ client })

      await tracker.hasSubscribers('room-a')
      tracker.dispose()
      await tracker.hasSubscribers('room-a')

      expect(client.call).toHaveBeenCalledTimes(2)
    })
  })
})
