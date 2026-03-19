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
        undefined,
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
        undefined,
      )
      expect(adapter.publish).toHaveBeenCalledWith(
        'room-b',
        expect.objectContaining({ event: 'testEvent' }),
        undefined,
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

  describe('pre-delivery filter', () => {
    it('should call filter before sending to each connection', async () => {
      const filter = vi.fn().mockReturnValue(true)
      broadcaster.setPreDeliveryFilter(filter)

      roomManager.join('conn-1', 'room-a')
      roomManager.join('conn-2', 'room-a')

      await broadcaster.broadcastMessage('room-a', {
        event: 'testEvent',
        data: { foo: 'bar' },
        id: 'msg-1',
      })

      expect(filter).toHaveBeenCalledTimes(2)
    })

    it('should skip connection when filter returns false', async () => {
      const filter = vi.fn().mockImplementation((connId: string) => connId !== 'conn-2')
      broadcaster.setPreDeliveryFilter(filter)

      roomManager.join('conn-1', 'room-a')
      roomManager.join('conn-2', 'room-a')
      roomManager.join('conn-3', 'room-a')

      const sent = await broadcaster.broadcastMessage('room-a', {
        event: 'testEvent',
        data: { foo: 'bar' },
        id: 'msg-1',
      })

      expect(sent).toBe(2)
      expect(sendEvent).toHaveBeenCalledTimes(2)
      expect(sendEvent).not.toHaveBeenCalledWith('conn-2', expect.anything())
    })

    it('should send to connection when filter returns true', async () => {
      const filter = vi.fn().mockReturnValue(true)
      broadcaster.setPreDeliveryFilter(filter)

      roomManager.join('conn-1', 'room-a')

      const sent = await broadcaster.broadcastMessage('room-a', {
        event: 'testEvent',
        data: { foo: 'bar' },
        id: 'msg-1',
      })

      expect(sent).toBe(1)
      expect(sendEvent).toHaveBeenCalledTimes(1)
    })

    it('should pass metadata to filter', async () => {
      const filter = vi.fn().mockReturnValue(true)
      broadcaster.setPreDeliveryFilter(filter)

      roomManager.join('conn-1', 'room-a')

      const metadata = { scope: 'project', projectId: '123' }
      await broadcaster.broadcastMessage('room-a', {
        event: 'testEvent',
        data: { foo: 'bar' },
        id: 'msg-1',
      }, { metadata })

      expect(filter).toHaveBeenCalledWith(
        'conn-1',
        expect.objectContaining({ event: 'testEvent' }),
        metadata,
      )
    })

    it('should not affect delivery when no filter is set', async () => {
      // No filter set — default behavior
      roomManager.join('conn-1', 'room-a')
      roomManager.join('conn-2', 'room-a')

      const sent = await broadcaster.broadcastMessage('room-a', {
        event: 'testEvent',
        data: { foo: 'bar' },
        id: 'msg-1',
      })

      expect(sent).toBe(2)
    })

    it('should apply filter during remote broadcast handling', async () => {
      const filter = vi.fn().mockImplementation((connId: string) => connId !== 'conn-1')
      broadcaster.setPreDeliveryFilter(filter)

      roomManager.join('conn-1', 'room-a')
      roomManager.join('conn-2', 'room-a')

      // Simulate remote broadcast via adapter — the room manager's handler
      // doesn't return the promise, so we need to await the microtask queue
      const adapterOnMessage = (adapter.onMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0]
      adapterOnMessage('room-a', { event: 'test', data: {}, id: 'remote-1' }, 'other-node', undefined)
      await new Promise((r) => setTimeout(r, 0))

      // conn-1 should be filtered out, conn-2 should receive
      expect(sendEvent).toHaveBeenCalledTimes(1)
      expect(sendEvent).toHaveBeenCalledWith('conn-2', expect.objectContaining({ event: 'test' }))
    })

    it('should pass metadata from remote broadcast to filter', async () => {
      const filter = vi.fn().mockReturnValue(true)
      broadcaster.setPreDeliveryFilter(filter)

      roomManager.join('conn-1', 'room-a')

      const metadata = { scope: 'team', teamId: 'eng' }
      const adapterOnMessage = (adapter.onMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0]
      adapterOnMessage('room-a', { event: 'test', data: {}, id: 'remote-1' }, 'other-node', metadata)
      await new Promise((r) => setTimeout(r, 0))

      expect(filter).toHaveBeenCalledWith(
        'conn-1',
        expect.objectContaining({ event: 'test' }),
        metadata,
      )
    })
  })

  describe('metadata in broadcastMessage', () => {
    it('should pass metadata to adapter.publish via room manager', async () => {
      roomManager.join('conn-1', 'room-a')

      const metadata = { scope: 'project', projectId: '123' }
      await broadcaster.broadcastMessage('room-a', {
        event: 'testEvent',
        data: { foo: 'bar' },
        id: 'msg-1',
      }, { metadata })

      expect(adapter.publish).toHaveBeenCalledWith(
        'room-a',
        expect.objectContaining({ event: 'testEvent' }),
        metadata,
      )
    })

    it('should not pass metadata to adapter when not provided', async () => {
      roomManager.join('conn-1', 'room-a')

      await broadcaster.broadcastMessage('room-a', {
        event: 'testEvent',
        data: { foo: 'bar' },
        id: 'msg-1',
      })

      expect(adapter.publish).toHaveBeenCalledWith(
        'room-a',
        expect.objectContaining({ event: 'testEvent' }),
        undefined,
      )
    })

    it('should pass metadata from broadcastToRoom options through to broadcastMessage', async () => {
      const testEvent = { event: 'testEvent' } as any
      roomManager.join('conn-1', 'room-a')

      const metadata = { scope: 'global' }
      await broadcaster.broadcastToRoom('room-a', testEvent, { foo: 'bar' }, { metadata })

      expect(adapter.publish).toHaveBeenCalledWith(
        'room-a',
        expect.objectContaining({ event: 'testEvent' }),
        metadata,
      )
    })
  })
})
