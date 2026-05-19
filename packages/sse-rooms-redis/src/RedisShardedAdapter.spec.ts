import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PresenceTracker } from './presence/types.ts'
import { RedisShardedAdapter } from './RedisShardedAdapter.ts'
import type { RedisRoomMessage, RedisShardedClientLike } from './types.ts'

function createMockShardedClient(): RedisShardedClientLike & {
  handlers: Map<string, (channel: string, message: string) => void>
  simulateMessage: (channel: string, message: string) => void
} {
  const handlers = new Map<string, (channel: string, message: string) => void>()
  return {
    handlers,
    spublish: vi.fn().mockResolvedValue(1),
    ssubscribe: vi.fn().mockResolvedValue(undefined),
    sunsubscribe: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((event: string, handler: (channel: string, message: string) => void) => {
      handlers.set(event, handler)
    }),
    simulateMessage(channel: string, message: string) {
      const handler = handlers.get('smessage')
      if (handler) {
        handler(channel, message)
      }
    },
  }
}

describe('RedisShardedAdapter', () => {
  let pubClient: ReturnType<typeof createMockShardedClient>
  let subClient: ReturnType<typeof createMockShardedClient>
  let adapter: RedisShardedAdapter

  beforeEach(() => {
    pubClient = createMockShardedClient()
    subClient = createMockShardedClient()
    adapter = new RedisShardedAdapter({
      pubClient,
      subClient,
      nodeId: 'test-node-1',
    })
  })

  describe('connect', () => {
    it('registers an smessage handler on subClient', async () => {
      await adapter.connect()
      expect(subClient.on).toHaveBeenCalledWith('smessage', expect.any(Function))
    })
  })

  describe('subscribe', () => {
    it('issues SSUBSCRIBE with prefixed channel', async () => {
      await adapter.subscribe('my-room')
      expect(subClient.ssubscribe).toHaveBeenCalledWith('sse:room:my-room')
    })

    it('does not re-subscribe to the same room', async () => {
      await adapter.subscribe('my-room')
      await adapter.subscribe('my-room')
      expect(subClient.ssubscribe).toHaveBeenCalledTimes(1)
    })

    it('honours custom channelPrefix', async () => {
      const a = new RedisShardedAdapter({
        pubClient,
        subClient,
        channelPrefix: 'custom:',
      })
      await a.subscribe('room-1')
      expect(subClient.ssubscribe).toHaveBeenCalledWith('custom:room-1')
    })
  })

  describe('unsubscribe', () => {
    it('issues SUNSUBSCRIBE for a previously subscribed room', async () => {
      await adapter.subscribe('my-room')
      await adapter.unsubscribe('my-room')
      expect(subClient.sunsubscribe).toHaveBeenCalledWith('sse:room:my-room')
    })

    it('is a no-op for an unknown room', async () => {
      await adapter.unsubscribe('my-room')
      expect(subClient.sunsubscribe).not.toHaveBeenCalled()
    })
  })

  describe('disconnect', () => {
    it('SUNSUBSCRIBEs from all subscribed channels', async () => {
      await adapter.subscribe('room-1')
      await adapter.subscribe('room-2')
      await adapter.disconnect()
      expect(subClient.sunsubscribe).toHaveBeenCalledWith('sse:room:room-1', 'sse:room:room-2')
    })

    it('is a no-op when nothing is subscribed', async () => {
      await adapter.disconnect()
      expect(subClient.sunsubscribe).not.toHaveBeenCalled()
    })
  })

  describe('publish', () => {
    it('issues SPUBLISH with the wire-format payload', async () => {
      await adapter.publish('my-room', { event: 'test', data: { foo: 'bar' } })

      expect(pubClient.spublish).toHaveBeenCalledWith('sse:room:my-room', expect.any(String))
      const publishedJson = (pubClient.spublish as ReturnType<typeof vi.fn>).mock.calls[0]![1]
      const parsed = JSON.parse(publishedJson) as RedisRoomMessage
      expect(parsed).toMatchObject({
        v: 1,
        m: { event: 'test', data: { foo: 'bar' } },
        n: 'test-node-1',
      })
    })

    it('includes meta when metadata is provided', async () => {
      await adapter.publish('my-room', { event: 'test', data: {} }, { scope: 'team' })

      const publishedJson = (pubClient.spublish as ReturnType<typeof vi.fn>).mock.calls[0]![1]
      const parsed = JSON.parse(publishedJson)
      expect(parsed.meta).toEqual({ scope: 'team' })
    })

    it('omits meta when metadata is absent', async () => {
      await adapter.publish('my-room', { event: 'test', data: {} })

      const publishedJson = (pubClient.spublish as ReturnType<typeof vi.fn>).mock.calls[0]![1]
      const parsed = JSON.parse(publishedJson)
      expect(parsed).not.toHaveProperty('meta')
    })
  })

  describe('onMessage', () => {
    it('dispatches decoded smessage payloads to the handler', async () => {
      const handler = vi.fn()
      adapter.onMessage(handler)
      await adapter.connect()

      const payload: RedisRoomMessage = {
        v: 1,
        m: { event: 'test', data: { foo: 'bar' } },
        n: 'other-node',
      }
      subClient.simulateMessage('sse:room:my-room', JSON.stringify(payload))

      expect(handler).toHaveBeenCalledWith(
        'my-room',
        { event: 'test', data: { foo: 'bar' } },
        'other-node',
        undefined,
      )
    })

    it('ignores messages with an unknown protocol version', async () => {
      const handler = vi.fn()
      adapter.onMessage(handler)
      await adapter.connect()

      subClient.simulateMessage('sse:room:my-room', JSON.stringify({ v: 99, m: {}, n: 'other' }))

      expect(handler).not.toHaveBeenCalled()
    })

    it('ignores invalid JSON', async () => {
      const handler = vi.fn()
      adapter.onMessage(handler)
      await adapter.connect()

      subClient.simulateMessage('sse:room:my-room', 'not-json')

      expect(handler).not.toHaveBeenCalled()
    })

    it('decodes meta when present', async () => {
      const handler = vi.fn()
      adapter.onMessage(handler)
      await adapter.connect()

      const payload = {
        v: 1,
        m: { event: 'test', data: {} },
        n: 'other-node',
        meta: { scope: 'team' },
      }
      subClient.simulateMessage('sse:room:my-room', JSON.stringify(payload))

      expect(handler).toHaveBeenCalledWith('my-room', expect.any(Object), 'other-node', {
        scope: 'team',
      })
    })
  })

  describe('presence tracker', () => {
    function makeTracker(overrides: Partial<PresenceTracker> = {}): PresenceTracker {
      return {
        hasSubscribers: vi.fn().mockResolvedValue(true),
        notifyLocalSubscribed: vi.fn(),
        notifyLocalUnsubscribed: vi.fn(),
        dispose: vi.fn(),
        ...overrides,
      }
    }

    it('skips SPUBLISH when tracker reports no subscribers', async () => {
      const tracker = makeTracker({ hasSubscribers: vi.fn().mockResolvedValue(false) })
      const a = new RedisShardedAdapter({ pubClient, subClient, presence: tracker })

      await a.publish('room-a', { event: 'test', data: {} })

      expect(pubClient.spublish).not.toHaveBeenCalled()
    })

    it('fails open — SPUBLISHes when the tracker throws', async () => {
      const tracker = makeTracker({
        hasSubscribers: vi.fn().mockRejectedValue(new Error('boom')),
      })
      const a = new RedisShardedAdapter({ pubClient, subClient, presence: tracker })

      await a.publish('room-a', { event: 'test', data: {} })

      expect(pubClient.spublish).toHaveBeenCalledTimes(1)
    })

    it('fires notifyLocalSubscribed after SSUBSCRIBE resolves', async () => {
      const tracker = makeTracker()
      const a = new RedisShardedAdapter({ pubClient, subClient, presence: tracker })
      const order: string[] = []
      subClient.ssubscribe = vi.fn(() => {
        order.push('ssubscribe')
        return Promise.resolve(undefined)
      })
      tracker.notifyLocalSubscribed = vi.fn(() => {
        order.push('notify')
      })

      await a.subscribe('room-a')

      expect(order).toEqual(['ssubscribe', 'notify'])
    })

    it('calls dispose on disconnect', async () => {
      const tracker = makeTracker()
      const a = new RedisShardedAdapter({ pubClient, subClient, presence: tracker })
      await a.disconnect()
      expect(tracker.dispose).toHaveBeenCalledTimes(1)
    })
  })
})
