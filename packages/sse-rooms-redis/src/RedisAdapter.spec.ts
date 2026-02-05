import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RedisAdapter } from './RedisAdapter.ts'
import type { RedisClientLike, RedisRoomMessage } from './types.ts'

function createMockRedisClient(): RedisClientLike & {
  handlers: Map<string, (channel: string, message: string) => void>
  simulateMessage: (channel: string, message: string) => void
} {
  const handlers = new Map<string, (channel: string, message: string) => void>()
  return {
    handlers,
    publish: vi.fn().mockResolvedValue(1),
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((event: string, handler: (channel: string, message: string) => void) => {
      handlers.set(event, handler)
    }),
    simulateMessage(channel: string, message: string) {
      const handler = handlers.get('message')
      if (handler) {
        handler(channel, message)
      }
    },
  }
}

describe('RedisAdapter', () => {
  let pubClient: ReturnType<typeof createMockRedisClient>
  let subClient: ReturnType<typeof createMockRedisClient>
  let adapter: RedisAdapter

  beforeEach(() => {
    pubClient = createMockRedisClient()
    subClient = createMockRedisClient()
    adapter = new RedisAdapter({
      pubClient,
      subClient,
      nodeId: 'test-node-1',
    })
  })

  describe('constructor', () => {
    it('should use default channel prefix', () => {
      const adapter = new RedisAdapter({
        pubClient,
        subClient,
      })
      expect(adapter).toBeDefined()
    })

    it('should accept custom channel prefix', () => {
      const adapter = new RedisAdapter({
        pubClient,
        subClient,
        channelPrefix: 'custom:prefix:',
      })
      expect(adapter).toBeDefined()
    })

    it('should generate nodeId if not provided', () => {
      const adapter = new RedisAdapter({
        pubClient,
        subClient,
      })
      expect(adapter).toBeDefined()
    })
  })

  describe('connect', () => {
    it('should set up message handler on subscriber client', async () => {
      await adapter.connect()

      expect(subClient.on).toHaveBeenCalledWith('message', expect.any(Function))
    })
  })

  describe('disconnect', () => {
    it('should unsubscribe from all channels', async () => {
      await adapter.connect()
      await adapter.subscribe('room-1')
      await adapter.subscribe('room-2')

      await adapter.disconnect()

      expect(subClient.unsubscribe).toHaveBeenCalledWith('sse:room:room-1', 'sse:room:room-2')
    })

    it('should handle disconnect with no subscriptions', async () => {
      await adapter.disconnect()

      expect(subClient.unsubscribe).not.toHaveBeenCalled()
    })
  })

  describe('subscribe', () => {
    it('should subscribe to Redis channel with prefix', async () => {
      await adapter.subscribe('my-room')

      expect(subClient.subscribe).toHaveBeenCalledWith('sse:room:my-room')
    })

    it('should not subscribe twice to the same room', async () => {
      await adapter.subscribe('my-room')
      await adapter.subscribe('my-room')

      expect(subClient.subscribe).toHaveBeenCalledTimes(1)
    })

    it('should use custom channel prefix', async () => {
      const customAdapter = new RedisAdapter({
        pubClient,
        subClient,
        channelPrefix: 'custom:',
      })

      await customAdapter.subscribe('room-1')

      expect(subClient.subscribe).toHaveBeenCalledWith('custom:room-1')
    })
  })

  describe('unsubscribe', () => {
    it('should unsubscribe from Redis channel', async () => {
      await adapter.subscribe('my-room')
      await adapter.unsubscribe('my-room')

      expect(subClient.unsubscribe).toHaveBeenCalledWith('sse:room:my-room')
    })

    it('should not unsubscribe if not subscribed', async () => {
      await adapter.unsubscribe('my-room')

      expect(subClient.unsubscribe).not.toHaveBeenCalled()
    })
  })

  describe('publish', () => {
    it('should publish message to Redis channel', async () => {
      const message = { event: 'test', data: { foo: 'bar' } }

      await adapter.publish('my-room', message)

      expect(pubClient.publish).toHaveBeenCalledWith('sse:room:my-room', expect.any(String))

      // Verify the published JSON
      const publishedJson = (pubClient.publish as ReturnType<typeof vi.fn>).mock.calls[0][1]
      const parsed = JSON.parse(publishedJson) as RedisRoomMessage
      expect(parsed).toMatchObject({
        v: 1,
        m: { event: 'test', data: { foo: 'bar' } },
        n: 'test-node-1',
      })
    })

    it('should include message id and retry when provided', async () => {
      const message = {
        event: 'test',
        data: { foo: 'bar' },
        id: 'msg-123',
        retry: 5000,
      }

      await adapter.publish('my-room', message)

      const publishedJson = (pubClient.publish as ReturnType<typeof vi.fn>).mock.calls[0][1]
      const parsed = JSON.parse(publishedJson) as RedisRoomMessage
      expect(parsed.m.id).toBe('msg-123')
      expect(parsed.m.retry).toBe(5000)
    })
  })

  describe('onMessage', () => {
    it('should register message handler', async () => {
      const handler = vi.fn()
      adapter.onMessage(handler)

      await adapter.connect()

      // Simulate receiving a message from another node
      const payload: RedisRoomMessage = {
        v: 1,
        m: { event: 'test', data: { foo: 'bar' } },
        n: 'other-node',
      }
      subClient.simulateMessage('sse:room:my-room', JSON.stringify(payload))

      expect(handler).toHaveBeenCalledWith(
        'my-room',
        { event: 'test', data: { foo: 'bar' }, id: undefined, retry: undefined },
        'other-node',
      )
    })

    it('should ignore messages with unknown protocol version', async () => {
      const handler = vi.fn()
      adapter.onMessage(handler)

      await adapter.connect()

      const payload = {
        v: 99, // Unknown version
        m: { event: 'test', data: {} },
        n: 'other-node',
      }
      subClient.simulateMessage('sse:room:my-room', JSON.stringify(payload))

      expect(handler).not.toHaveBeenCalled()
    })

    it('should ignore invalid JSON messages', async () => {
      const handler = vi.fn()
      adapter.onMessage(handler)

      await adapter.connect()

      subClient.simulateMessage('sse:room:my-room', 'not-valid-json')

      expect(handler).not.toHaveBeenCalled()
    })

    it('should extract room name from channel', async () => {
      const handler = vi.fn()
      adapter.onMessage(handler)

      await adapter.connect()

      const payload: RedisRoomMessage = {
        v: 1,
        m: { event: 'test', data: {} },
        n: 'other-node',
      }
      subClient.simulateMessage('sse:room:chat:general', JSON.stringify(payload))

      expect(handler).toHaveBeenCalledWith(
        'chat:general', // Room name extracted correctly
        expect.any(Object),
        'other-node',
      )
    })

    it('should work with custom channel prefix', async () => {
      const customAdapter = new RedisAdapter({
        pubClient,
        subClient,
        channelPrefix: 'custom:prefix:',
        nodeId: 'test-node',
      })
      const handler = vi.fn()
      customAdapter.onMessage(handler)

      await customAdapter.connect()

      const payload: RedisRoomMessage = {
        v: 1,
        m: { event: 'test', data: {} },
        n: 'other-node',
      }
      subClient.simulateMessage('custom:prefix:my-room', JSON.stringify(payload))

      expect(handler).toHaveBeenCalledWith('my-room', expect.any(Object), 'other-node')
    })
  })
})
