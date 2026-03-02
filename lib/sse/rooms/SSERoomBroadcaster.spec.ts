import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SSEMessage } from '../sseTypes.js'
import { SSERoomBroadcaster } from './SSERoomBroadcaster.js'
import { SSERoomManager } from './SSERoomManager.js'
import type { SSERoomAdapter } from './types.js'

// Minimal contract type for testing
type TestContracts = Record<string, never>

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
  let broadcaster: SSERoomBroadcaster<TestContracts>
  let adapter: SSERoomAdapter

  beforeEach(() => {
    adapter = createMockAdapter()
    roomManager = new SSERoomManager({ adapter })
    sendEvent = vi.fn().mockResolvedValue(true)
    broadcaster = new SSERoomBroadcaster<TestContracts>(roomManager, sendEvent)
  })

  describe('broadcastToRoom', () => {
    it('should send to all connections in a room', async () => {
      roomManager.join('conn-1', 'room-a')
      roomManager.join('conn-2', 'room-a')
      roomManager.join('conn-3', 'room-a')

      const sent = await broadcaster.broadcastToRoom(
        'room-a',
        'testEvent' as never,
        { foo: 'bar' } as never,
      )

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

      const sent = await broadcaster.broadcastToRoom(
        ['room-a', 'room-b'],
        'testEvent' as never,
        { foo: 'bar' } as never,
      )

      // conn-1 is in both rooms but should only receive once
      expect(sent).toBe(3)
      expect(sendEvent).toHaveBeenCalledTimes(3)
    })

    it('should publish to adapter for cross-node propagation', async () => {
      roomManager.join('conn-1', 'room-a')

      await broadcaster.broadcastToRoom('room-a', 'testEvent' as never, { foo: 'bar' } as never)

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

      await broadcaster.broadcastToRoom(
        ['room-a', 'room-b'],
        'testEvent' as never,
        { foo: 'bar' } as never,
      )

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

      await broadcaster.broadcastToRoom('room-a', 'testEvent' as never, { foo: 'bar' } as never, {
        local: true,
      })

      expect(adapter.publish).not.toHaveBeenCalled()
      // Should still send to local connections
      expect(sendEvent).toHaveBeenCalledTimes(1)
    })

    it('should generate a message ID when not provided', async () => {
      roomManager.join('conn-1', 'room-a')

      await broadcaster.broadcastToRoom('room-a', 'testEvent' as never, { foo: 'bar' } as never)

      const message = sendEvent.mock.calls[0]![1] as SSEMessage
      expect(message.id).toBeDefined()
      expect(typeof message.id).toBe('string')
    })

    it('should use provided message ID', async () => {
      roomManager.join('conn-1', 'room-a')

      await broadcaster.broadcastToRoom('room-a', 'testEvent' as never, { foo: 'bar' } as never, {
        id: 'custom-id',
      })

      const message = sendEvent.mock.calls[0]![1] as SSEMessage
      expect(message.id).toBe('custom-id')
    })

    it('should pass retry option through to message', async () => {
      roomManager.join('conn-1', 'room-a')

      await broadcaster.broadcastToRoom('room-a', 'testEvent' as never, { foo: 'bar' } as never, {
        retry: 5000,
      })

      const message = sendEvent.mock.calls[0]![1] as SSEMessage
      expect(message.retry).toBe(5000)
    })

    it('should return 0 when room has no connections', async () => {
      const sent = await broadcaster.broadcastToRoom(
        'empty-room',
        'testEvent' as never,
        { foo: 'bar' } as never,
      )

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

      const sent = await broadcaster.broadcastToRoom(
        'room-a',
        'testEvent' as never,
        { foo: 'bar' } as never,
      )

      expect(sent).toBe(2)
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
})
