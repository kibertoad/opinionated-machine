import { describe, expect, it, vi, beforeEach } from 'vitest'
import { SSERoomManager } from './SSERoomManager.ts'
import { InMemoryAdapter } from './adapters/InMemoryAdapter.ts'
import type { SSERoomAdapter } from './types.ts'

describe('SSERoomManager', () => {
  describe('constructor', () => {
    it('should use InMemoryAdapter by default', () => {
      const manager = new SSERoomManager()
      expect(manager.adapter).toBeInstanceOf(InMemoryAdapter)
    })

    it('should use provided adapter', () => {
      const customAdapter = new InMemoryAdapter()
      const manager = new SSERoomManager({ adapter: customAdapter })
      expect(manager.adapter).toBe(customAdapter)
    })

    it('should enable autoJoinSelfRoom by default', () => {
      const manager = new SSERoomManager()
      manager.onConnectionRegistered('conn-1')
      expect(manager.getRooms('conn-1')).toContain('conn-1')
    })

    it('should respect autoJoinSelfRoom: false', () => {
      const manager = new SSERoomManager({ autoJoinSelfRoom: false })
      manager.onConnectionRegistered('conn-1')
      expect(manager.getRooms('conn-1')).toHaveLength(0)
    })

    it('should generate nodeId if not provided', () => {
      const manager = new SSERoomManager()
      expect(manager.nodeId).toBeDefined()
      expect(typeof manager.nodeId).toBe('string')
    })

    it('should use provided nodeId', () => {
      const manager = new SSERoomManager({ nodeId: 'custom-node-id' })
      expect(manager.nodeId).toBe('custom-node-id')
    })
  })

  describe('join', () => {
    let manager: SSERoomManager

    beforeEach(() => {
      manager = new SSERoomManager({ autoJoinSelfRoom: false })
    })

    it('should add connection to a single room', () => {
      manager.join('conn-1', 'room-a')

      expect(manager.getRooms('conn-1')).toEqual(['room-a'])
      expect(manager.getConnectionsInRoom('room-a')).toEqual(['conn-1'])
    })

    it('should add connection to multiple rooms', () => {
      manager.join('conn-1', ['room-a', 'room-b', 'room-c'])

      expect(manager.getRooms('conn-1')).toEqual(['room-a', 'room-b', 'room-c'])
    })

    it('should handle joining the same room twice (idempotent)', () => {
      manager.join('conn-1', 'room-a')
      manager.join('conn-1', 'room-a')

      expect(manager.getRooms('conn-1')).toEqual(['room-a'])
      expect(manager.getConnectionsInRoom('room-a')).toEqual(['conn-1'])
    })

    it('should add multiple connections to the same room', () => {
      manager.join('conn-1', 'room-a')
      manager.join('conn-2', 'room-a')
      manager.join('conn-3', 'room-a')

      expect(manager.getConnectionsInRoom('room-a')).toEqual(['conn-1', 'conn-2', 'conn-3'])
    })

    it('should call adapter.subscribe when first connection joins a room', async () => {
      const adapter: SSERoomAdapter = {
        connect: vi.fn(),
        disconnect: vi.fn(),
        subscribe: vi.fn().mockResolvedValue(undefined),
        unsubscribe: vi.fn().mockResolvedValue(undefined),
        publish: vi.fn().mockResolvedValue(undefined),
        onMessage: vi.fn(),
      }
      manager = new SSERoomManager({ adapter, autoJoinSelfRoom: false })

      manager.join('conn-1', 'room-a')
      await vi.waitFor(() => expect(adapter.subscribe).toHaveBeenCalledWith('room-a'))

      // Second join should not subscribe again
      manager.join('conn-2', 'room-a')
      expect(adapter.subscribe).toHaveBeenCalledTimes(1)
    })
  })

  describe('leave', () => {
    let manager: SSERoomManager

    beforeEach(() => {
      manager = new SSERoomManager({ autoJoinSelfRoom: false })
      manager.join('conn-1', ['room-a', 'room-b', 'room-c'])
    })

    it('should remove connection from a single room', () => {
      manager.leave('conn-1', 'room-a')

      expect(manager.getRooms('conn-1')).toEqual(['room-b', 'room-c'])
      expect(manager.getConnectionsInRoom('room-a')).toEqual([])
    })

    it('should remove connection from multiple rooms', () => {
      manager.leave('conn-1', ['room-a', 'room-b'])

      expect(manager.getRooms('conn-1')).toEqual(['room-c'])
    })

    it('should handle leaving a room not in (no-op)', () => {
      manager.leave('conn-1', 'room-x')

      expect(manager.getRooms('conn-1')).toEqual(['room-a', 'room-b', 'room-c'])
    })

    it('should handle leaving for non-existent connection (no-op)', () => {
      manager.leave('conn-x', 'room-a')

      // Original state unchanged
      expect(manager.getConnectionsInRoom('room-a')).toEqual(['conn-1'])
    })

    it('should call adapter.unsubscribe when last connection leaves a room', async () => {
      const adapter: SSERoomAdapter = {
        connect: vi.fn(),
        disconnect: vi.fn(),
        subscribe: vi.fn().mockResolvedValue(undefined),
        unsubscribe: vi.fn().mockResolvedValue(undefined),
        publish: vi.fn().mockResolvedValue(undefined),
        onMessage: vi.fn(),
      }
      manager = new SSERoomManager({ adapter, autoJoinSelfRoom: false })
      manager.join('conn-1', 'room-a')
      manager.join('conn-2', 'room-a')

      // First leave should not unsubscribe (conn-2 still in room)
      manager.leave('conn-1', 'room-a')
      expect(adapter.unsubscribe).not.toHaveBeenCalled()

      // Last leave should unsubscribe
      manager.leave('conn-2', 'room-a')
      await vi.waitFor(() => expect(adapter.unsubscribe).toHaveBeenCalledWith('room-a'))
    })
  })

  describe('leaveAll', () => {
    let manager: SSERoomManager

    beforeEach(() => {
      manager = new SSERoomManager({ autoJoinSelfRoom: false })
    })

    it('should remove connection from all rooms', () => {
      manager.join('conn-1', ['room-a', 'room-b', 'room-c'])
      manager.join('conn-2', ['room-a', 'room-b'])

      const leftRooms = manager.leaveAll('conn-1')

      expect(leftRooms).toEqual(['room-a', 'room-b', 'room-c'])
      expect(manager.getRooms('conn-1')).toEqual([])
      expect(manager.getConnectionsInRoom('room-a')).toEqual(['conn-2'])
      expect(manager.getConnectionsInRoom('room-b')).toEqual(['conn-2'])
      expect(manager.getConnectionsInRoom('room-c')).toEqual([])
    })

    it('should return empty array for non-existent connection', () => {
      const leftRooms = manager.leaveAll('conn-x')
      expect(leftRooms).toEqual([])
    })
  })

  describe('getRooms', () => {
    let manager: SSERoomManager

    beforeEach(() => {
      manager = new SSERoomManager({ autoJoinSelfRoom: false })
    })

    it('should return all rooms for a connection', () => {
      manager.join('conn-1', ['room-a', 'room-b'])

      expect(manager.getRooms('conn-1')).toEqual(['room-a', 'room-b'])
    })

    it('should return empty array for non-existent connection', () => {
      expect(manager.getRooms('conn-x')).toEqual([])
    })
  })

  describe('getConnectionsInRoom', () => {
    let manager: SSERoomManager

    beforeEach(() => {
      manager = new SSERoomManager({ autoJoinSelfRoom: false })
    })

    it('should return all connections in a room', () => {
      manager.join('conn-1', 'room-a')
      manager.join('conn-2', 'room-a')
      manager.join('conn-3', 'room-a')

      expect(manager.getConnectionsInRoom('room-a')).toEqual(['conn-1', 'conn-2', 'conn-3'])
    })

    it('should return empty array for non-existent room', () => {
      expect(manager.getConnectionsInRoom('room-x')).toEqual([])
    })
  })

  describe('getConnectionCountInRoom', () => {
    let manager: SSERoomManager

    beforeEach(() => {
      manager = new SSERoomManager({ autoJoinSelfRoom: false })
    })

    it('should return count of connections in a room', () => {
      manager.join('conn-1', 'room-a')
      manager.join('conn-2', 'room-a')
      manager.join('conn-3', 'room-a')

      expect(manager.getConnectionCountInRoom('room-a')).toBe(3)
    })

    it('should return 0 for non-existent room', () => {
      expect(manager.getConnectionCountInRoom('room-x')).toBe(0)
    })
  })

  describe('isInRoom', () => {
    let manager: SSERoomManager

    beforeEach(() => {
      manager = new SSERoomManager({ autoJoinSelfRoom: false })
    })

    it('should return true if connection is in room', () => {
      manager.join('conn-1', 'room-a')

      expect(manager.isInRoom('conn-1', 'room-a')).toBe(true)
    })

    it('should return false if connection is not in room', () => {
      manager.join('conn-1', 'room-a')

      expect(manager.isInRoom('conn-1', 'room-b')).toBe(false)
    })

    it('should return false for non-existent connection', () => {
      expect(manager.isInRoom('conn-x', 'room-a')).toBe(false)
    })
  })

  describe('getAllRooms', () => {
    let manager: SSERoomManager

    beforeEach(() => {
      manager = new SSERoomManager({ autoJoinSelfRoom: false })
    })

    it('should return all rooms with connections', () => {
      manager.join('conn-1', ['room-a', 'room-b'])
      manager.join('conn-2', ['room-b', 'room-c'])

      const rooms = manager.getAllRooms()
      expect(rooms).toHaveLength(3)
      expect(rooms).toContain('room-a')
      expect(rooms).toContain('room-b')
      expect(rooms).toContain('room-c')
    })

    it('should return empty array when no connections', () => {
      expect(manager.getAllRooms()).toEqual([])
    })

    it('should not include empty rooms', () => {
      manager.join('conn-1', 'room-a')
      manager.leave('conn-1', 'room-a')

      expect(manager.getAllRooms()).toEqual([])
    })
  })

  describe('publish', () => {
    it('should call adapter.publish', async () => {
      const adapter: SSERoomAdapter = {
        connect: vi.fn(),
        disconnect: vi.fn(),
        subscribe: vi.fn().mockResolvedValue(undefined),
        unsubscribe: vi.fn().mockResolvedValue(undefined),
        publish: vi.fn().mockResolvedValue(undefined),
        onMessage: vi.fn(),
      }
      const manager = new SSERoomManager({ adapter, autoJoinSelfRoom: false })

      const message = { event: 'test', data: { foo: 'bar' } }
      await manager.publish('room-a', message)

      expect(adapter.publish).toHaveBeenCalledWith('room-a', message, undefined)
    })

    it('should pass except option to adapter', async () => {
      const adapter: SSERoomAdapter = {
        connect: vi.fn(),
        disconnect: vi.fn(),
        subscribe: vi.fn().mockResolvedValue(undefined),
        unsubscribe: vi.fn().mockResolvedValue(undefined),
        publish: vi.fn().mockResolvedValue(undefined),
        onMessage: vi.fn(),
      }
      const manager = new SSERoomManager({ adapter, autoJoinSelfRoom: false })

      const message = { event: 'test', data: { foo: 'bar' } }
      await manager.publish('room-a', message, { except: 'conn-1' })

      expect(adapter.publish).toHaveBeenCalledWith('room-a', message, 'conn-1')
    })

    it('should not call adapter.publish when local: true', async () => {
      const adapter: SSERoomAdapter = {
        connect: vi.fn(),
        disconnect: vi.fn(),
        subscribe: vi.fn().mockResolvedValue(undefined),
        unsubscribe: vi.fn().mockResolvedValue(undefined),
        publish: vi.fn().mockResolvedValue(undefined),
        onMessage: vi.fn(),
      }
      const manager = new SSERoomManager({ adapter, autoJoinSelfRoom: false })

      const message = { event: 'test', data: { foo: 'bar' } }
      await manager.publish('room-a', message, { local: true })

      expect(adapter.publish).not.toHaveBeenCalled()
    })
  })

  describe('onRemoteMessage', () => {
    it('should call registered handler for messages from other nodes', () => {
      const adapter: SSERoomAdapter = {
        connect: vi.fn(),
        disconnect: vi.fn(),
        subscribe: vi.fn().mockResolvedValue(undefined),
        unsubscribe: vi.fn().mockResolvedValue(undefined),
        publish: vi.fn().mockResolvedValue(undefined),
        onMessage: vi.fn(),
      }
      const manager = new SSERoomManager({ adapter, nodeId: 'node-1', autoJoinSelfRoom: false })

      const handler = vi.fn()
      manager.onRemoteMessage(handler)

      // Simulate adapter receiving a message from another node
      const mockCalls = (adapter.onMessage as ReturnType<typeof vi.fn>).mock.calls
      expect(mockCalls.length).toBeGreaterThan(0)
      const onMessageHandler = mockCalls[0]![0] as (
        room: string,
        message: unknown,
        nodeId: string,
        except?: string,
      ) => void
      const message = { event: 'test', data: { foo: 'bar' } }
      onMessageHandler('room-a', message, 'node-2', 'except-conn')

      expect(handler).toHaveBeenCalledWith('room-a', message, 'node-2', 'except-conn')
    })

    it('should not call handler for messages from same node', () => {
      const adapter: SSERoomAdapter = {
        connect: vi.fn(),
        disconnect: vi.fn(),
        subscribe: vi.fn().mockResolvedValue(undefined),
        unsubscribe: vi.fn().mockResolvedValue(undefined),
        publish: vi.fn().mockResolvedValue(undefined),
        onMessage: vi.fn(),
      }
      const manager = new SSERoomManager({ adapter, nodeId: 'node-1', autoJoinSelfRoom: false })

      const handler = vi.fn()
      manager.onRemoteMessage(handler)

      // Simulate adapter receiving a message from the same node (echo)
      const mockCalls = (adapter.onMessage as ReturnType<typeof vi.fn>).mock.calls
      expect(mockCalls.length).toBeGreaterThan(0)
      const onMessageHandler = mockCalls[0]![0] as (
        room: string,
        message: unknown,
        nodeId: string,
        except?: string,
      ) => void
      const message = { event: 'test', data: { foo: 'bar' } }
      onMessageHandler('room-a', message, 'node-1', undefined)

      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('connect/disconnect', () => {
    it('should call adapter.connect on connect', async () => {
      const adapter: SSERoomAdapter = {
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn().mockResolvedValue(undefined),
        unsubscribe: vi.fn().mockResolvedValue(undefined),
        publish: vi.fn().mockResolvedValue(undefined),
        onMessage: vi.fn(),
      }
      const manager = new SSERoomManager({ adapter, autoJoinSelfRoom: false })

      await manager.connect()

      expect(adapter.connect).toHaveBeenCalled()
    })

    it('should call adapter.disconnect on disconnect', async () => {
      const adapter: SSERoomAdapter = {
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn().mockResolvedValue(undefined),
        unsubscribe: vi.fn().mockResolvedValue(undefined),
        publish: vi.fn().mockResolvedValue(undefined),
        onMessage: vi.fn(),
      }
      const manager = new SSERoomManager({ adapter, autoJoinSelfRoom: false })

      await manager.disconnect()

      expect(adapter.disconnect).toHaveBeenCalled()
    })
  })
})
