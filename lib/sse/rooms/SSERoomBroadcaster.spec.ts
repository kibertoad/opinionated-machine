import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { defineEvent } from '../defineEvent.js'
import type { SSEMessage } from '../sseTypes.js'
import { SSERoomBroadcaster } from './SSERoomBroadcaster.js'
import { SSERoomManager } from './SSERoomManager.js'
import type { SSERoomAdapter } from './types.js'

function createMockAdapter(): SSERoomAdapter {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn(),
  }
}

describe('SSERoomBroadcaster', () => {
  let roomManager: SSERoomManager
  let sendEvent: ReturnType<
    typeof vi.fn<(connectionId: string, message: SSEMessage) => Promise<boolean>>
  >
  let broadcaster: SSERoomBroadcaster
  let adapter: SSERoomAdapter

  beforeEach(() => {
    adapter = createMockAdapter()
    roomManager = new SSERoomManager({ adapter })
    sendEvent = vi.fn().mockResolvedValue(true)
    broadcaster = new SSERoomBroadcaster({ sseRoomManager: roomManager })
    broadcaster.registerSender(sendEvent)
  })

  describe('broadcastMessage', () => {
    it('should send to all connections in a room', async () => {
      roomManager.join('conn-1', 'room-a')
      roomManager.join('conn-2', 'room-a')
      roomManager.join('conn-3', 'room-a')

      const sent = await broadcaster.broadcastMessage('room-a', {
        event: 'testEvent',
        data: { foo: 'bar' },
        id: 'msg-1',
      })

      expect(sent).toBe(3)
      expect(sendEvent).toHaveBeenCalledTimes(3)
      expect(sendEvent).toHaveBeenCalledWith(
        'conn-1',
        expect.objectContaining({
          event: 'testEvent',
          data: { foo: 'bar' },
        }),
      )
      expect(sendEvent).toHaveBeenCalledWith(
        'conn-2',
        expect.objectContaining({
          event: 'testEvent',
          data: { foo: 'bar' },
        }),
      )
      expect(sendEvent).toHaveBeenCalledWith(
        'conn-3',
        expect.objectContaining({
          event: 'testEvent',
          data: { foo: 'bar' },
        }),
      )
    })

    it('should deduplicate connections across multiple rooms', async () => {
      roomManager.join('conn-1', ['room-a', 'room-b'])
      roomManager.join('conn-2', 'room-a')
      roomManager.join('conn-3', 'room-b')

      const sent = await broadcaster.broadcastMessage(['room-a', 'room-b'], {
        event: 'testEvent',
        data: { foo: 'bar' },
        id: 'msg-1',
      })

      // conn-1 is in both rooms but should only receive once
      expect(sent).toBe(3)
      expect(sendEvent).toHaveBeenCalledTimes(3)
    })

    it('should publish to adapter for cross-node propagation', async () => {
      roomManager.join('conn-1', 'room-a')

      await broadcaster.broadcastMessage('room-a', {
        event: 'testEvent',
        data: { foo: 'bar' },
        id: 'msg-1',
      })

      expect(adapter.publish).toHaveBeenCalledWith(
        'room-a',
        expect.objectContaining({
          event: 'testEvent',
          data: { foo: 'bar' },
        }),
      )
    })

    it('should publish to adapter for each room when broadcasting to multiple rooms', async () => {
      roomManager.join('conn-1', ['room-a', 'room-b'])

      await broadcaster.broadcastMessage(['room-a', 'room-b'], {
        event: 'testEvent',
        data: { foo: 'bar' },
        id: 'msg-1',
      })

      expect(adapter.publish).toHaveBeenCalledTimes(2)
      expect(adapter.publish).toHaveBeenCalledWith(
        'room-a',
        expect.objectContaining({ event: 'testEvent' }),
      )
      expect(adapter.publish).toHaveBeenCalledWith(
        'room-b',
        expect.objectContaining({ event: 'testEvent' }),
      )
    })

    it('should skip adapter when local: true', async () => {
      roomManager.join('conn-1', 'room-a')

      await broadcaster.broadcastMessage(
        'room-a',
        { event: 'testEvent', data: { foo: 'bar' }, id: 'msg-1' },
        { local: true },
      )

      expect(adapter.publish).not.toHaveBeenCalled()
      // Should still send to local connections
      expect(sendEvent).toHaveBeenCalledTimes(1)
    })

    it('should return 0 when room has no connections', async () => {
      const sent = await broadcaster.broadcastMessage('empty-room', {
        event: 'testEvent',
        data: { foo: 'bar' },
        id: 'msg-1',
      })

      expect(sent).toBe(0)
      expect(sendEvent).not.toHaveBeenCalled()
    })

    it('should count only successful sends', async () => {
      roomManager.join('conn-1', 'room-a')
      roomManager.join('conn-2', 'room-a')
      roomManager.join('conn-3', 'room-a')

      sendEvent
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false) // conn-2 failed (e.g., disconnected)
        .mockResolvedValueOnce(true)

      const sent = await broadcaster.broadcastMessage('room-a', {
        event: 'testEvent',
        data: { foo: 'bar' },
        id: 'msg-1',
      })

      expect(sent).toBe(2)
    })
  })

  describe('broadcastToRoom with SSEEventDefinition', () => {
    const testEvent = defineEvent('testEvent', z.object({ foo: z.string() }))

    it('should send to all connections in a room', async () => {
      roomManager.join('conn-1', 'room-a')
      roomManager.join('conn-2', 'room-a')

      const sent = await broadcaster.broadcastToRoom('room-a', testEvent, { foo: 'bar' })

      expect(sent).toBe(2)
      expect(sendEvent).toHaveBeenCalledTimes(2)
      expect(sendEvent).toHaveBeenCalledWith(
        'conn-1',
        expect.objectContaining({
          event: 'testEvent',
          data: { foo: 'bar' },
        }),
      )
    })

    it('should generate a message ID when not provided', async () => {
      roomManager.join('conn-1', 'room-a')

      await broadcaster.broadcastToRoom('room-a', testEvent, { foo: 'bar' })

      const message = sendEvent.mock.calls[0]![1] as SSEMessage
      expect(message.id).toBeDefined()
      expect(typeof message.id).toBe('string')
    })

    it('should use provided message ID', async () => {
      roomManager.join('conn-1', 'room-a')

      await broadcaster.broadcastToRoom('room-a', testEvent, { foo: 'bar' }, { id: 'custom-id' })

      const message = sendEvent.mock.calls[0]![1] as SSEMessage
      expect(message.id).toBe('custom-id')
    })

    it('should pass retry option through to message', async () => {
      roomManager.join('conn-1', 'room-a')

      await broadcaster.broadcastToRoom('room-a', testEvent, { foo: 'bar' }, { retry: 5000 })

      const message = sendEvent.mock.calls[0]![1] as SSEMessage
      expect(message.retry).toBe(5000)
    })

    it('should skip adapter when local: true', async () => {
      roomManager.join('conn-1', 'room-a')

      await broadcaster.broadcastToRoom('room-a', testEvent, { foo: 'bar' }, { local: true })

      expect(adapter.publish).not.toHaveBeenCalled()
      expect(sendEvent).toHaveBeenCalledTimes(1)
    })
  })

  describe('registerSender', () => {
    it('should try senders in order — first to return true wins', async () => {
      const sender1 = vi.fn().mockResolvedValue(false)
      const sender2 = vi.fn().mockResolvedValue(true)
      const sender3 = vi.fn().mockResolvedValue(true)

      // Reset broadcaster with custom senders
      const freshBroadcaster = new SSERoomBroadcaster({ sseRoomManager: roomManager })
      freshBroadcaster.registerSender(sender1)
      freshBroadcaster.registerSender(sender2)
      freshBroadcaster.registerSender(sender3)

      roomManager.join('conn-1', 'room-a')

      await freshBroadcaster.broadcastMessage('room-a', {
        event: 'test',
        data: {},
        id: 'msg-1',
      })

      expect(sender1).toHaveBeenCalledTimes(1)
      expect(sender2).toHaveBeenCalledTimes(1)
      expect(sender3).not.toHaveBeenCalled() // sender2 succeeded
    })
  })

  describe('cleanupConnection', () => {
    it('should clean up dedup cache for disconnected connection', () => {
      // Direct test: just verify cleanupConnection doesn't throw
      broadcaster.cleanupConnection('conn-1')
      broadcaster.cleanupConnection('non-existent')
    })
  })

  describe('getConnectionsInRoom', () => {
    it('should delegate to room manager', () => {
      roomManager.join('conn-1', 'room-a')
      roomManager.join('conn-2', 'room-a')

      expect(broadcaster.getConnectionsInRoom('room-a')).toEqual(['conn-1', 'conn-2'])
    })

    it('should return empty array for non-existent room', () => {
      expect(broadcaster.getConnectionsInRoom('room-x')).toEqual([])
    })
  })

  describe('getConnectionCountInRoom', () => {
    it('should delegate to room manager', () => {
      roomManager.join('conn-1', 'room-a')
      roomManager.join('conn-2', 'room-a')
      roomManager.join('conn-3', 'room-a')

      expect(broadcaster.getConnectionCountInRoom('room-a')).toBe(3)
    })

    it('should return 0 for non-existent room', () => {
      expect(broadcaster.getConnectionCountInRoom('room-x')).toBe(0)
    })
  })

  describe('roomManager getter', () => {
    it('should expose the underlying room manager', () => {
      expect(broadcaster.roomManager).toBe(roomManager)
    })
  })
})
