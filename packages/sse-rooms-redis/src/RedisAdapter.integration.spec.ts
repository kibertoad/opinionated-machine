import { Redis } from 'ioredis'
import type { SSEMessage } from 'opinionated-machine'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { RedisAdapter } from './RedisAdapter.ts'

/**
 * Integration tests for RedisAdapter using real Redis.
 *
 * These tests require Redis to be running on localhost:6379.
 * Run with: npm run test:docker
 */
describe('RedisAdapter Integration', () => {
  let pubClient1: Redis
  let subClient1: Redis
  let pubClient2: Redis
  let subClient2: Redis

  beforeAll(async () => {
    // Create Redis clients for two simulated nodes
    pubClient1 = new Redis({ host: 'localhost', port: 6379, lazyConnect: true })
    subClient1 = new Redis({ host: 'localhost', port: 6379, lazyConnect: true })
    pubClient2 = new Redis({ host: 'localhost', port: 6379, lazyConnect: true })
    subClient2 = new Redis({ host: 'localhost', port: 6379, lazyConnect: true })

    await Promise.all([
      pubClient1.connect(),
      subClient1.connect(),
      pubClient2.connect(),
      subClient2.connect(),
    ])
  })

  afterAll(async () => {
    await Promise.all([pubClient1.quit(), subClient1.quit(), pubClient2.quit(), subClient2.quit()])
  })

  describe('cross-node communication', () => {
    let adapter1: RedisAdapter
    let adapter2: RedisAdapter

    beforeEach(async () => {
      adapter1 = new RedisAdapter({
        pubClient: pubClient1,
        subClient: subClient1,
        nodeId: 'node-1',
        channelPrefix: 'test:sse:room:',
      })

      adapter2 = new RedisAdapter({
        pubClient: pubClient2,
        subClient: subClient2,
        nodeId: 'node-2',
        channelPrefix: 'test:sse:room:',
      })

      await adapter1.connect()
      await adapter2.connect()
    })

    afterEach(async () => {
      await adapter1.disconnect()
      await adapter2.disconnect()
    })

    it('should propagate messages between nodes', async () => {
      const receivedMessages: Array<{
        room: string
        message: SSEMessage
        sourceNodeId: string
      }> = []

      // Set up handler on node 2
      adapter2.onMessage((room: string, message: SSEMessage, sourceNodeId: string) => {
        receivedMessages.push({ room, message, sourceNodeId })
      })

      // Subscribe node 2 to the room
      await adapter2.subscribe('test-room')

      // Small delay to ensure subscription is ready
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Publish from node 1
      await adapter1.publish('test-room', {
        event: 'chat',
        data: { text: 'Hello from node 1!' },
      })

      // Wait for message to propagate
      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(receivedMessages).toHaveLength(1)
      expect(receivedMessages[0]).toMatchObject({
        room: 'test-room',
        message: {
          event: 'chat',
          data: { text: 'Hello from node 1!' },
        },
        sourceNodeId: 'node-1',
      })
    })

    it('should handle multiple rooms independently', async () => {
      const receivedOnNode2: string[] = []

      adapter2.onMessage((room: string) => {
        receivedOnNode2.push(room)
      })

      // Subscribe to multiple rooms
      await adapter2.subscribe('room-a')
      await adapter2.subscribe('room-b')
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Publish to different rooms
      await adapter1.publish('room-a', { event: 'a', data: {} })
      await adapter1.publish('room-b', { event: 'b', data: {} })
      await adapter1.publish('room-c', { event: 'c', data: {} }) // Not subscribed

      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(receivedOnNode2).toContain('room-a')
      expect(receivedOnNode2).toContain('room-b')
      expect(receivedOnNode2).not.toContain('room-c')
    })

    it('should stop receiving after unsubscribe', async () => {
      const receivedMessages: string[] = []

      adapter2.onMessage((room: string) => {
        receivedMessages.push(room)
      })

      await adapter2.subscribe('ephemeral-room')
      await new Promise((resolve) => setTimeout(resolve, 100))

      // First message should be received
      await adapter1.publish('ephemeral-room', { event: 'before', data: {} })
      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(receivedMessages).toHaveLength(1)

      // Unsubscribe
      await adapter2.unsubscribe('ephemeral-room')
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Second message should NOT be received
      await adapter1.publish('ephemeral-room', { event: 'after', data: {} })
      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(receivedMessages).toHaveLength(1) // Still 1, not 2
    })

    it('should handle rapid sequential publishes', async () => {
      const receivedMessages: SSEMessage[] = []

      adapter2.onMessage((_: string, message: SSEMessage) => {
        receivedMessages.push(message)
      })

      await adapter2.subscribe('rapid-room')
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Send many messages quickly
      const promises = []
      for (let i = 0; i < 10; i++) {
        promises.push(
          adapter1.publish('rapid-room', {
            event: 'count',
            data: { index: i },
          }),
        )
      }
      await Promise.all(promises)

      // Wait for all messages to arrive
      await new Promise((resolve) => setTimeout(resolve, 200))

      expect(receivedMessages).toHaveLength(10)

      // Verify all indices are present (order may vary)
      const indices = receivedMessages.map((m) => (m.data as { index: number }).index).sort()
      expect(indices).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    })

    it('should support bi-directional communication', async () => {
      const node1Received: string[] = []
      const node2Received: string[] = []

      adapter1.onMessage((room: string) => {
        node1Received.push(room)
      })

      adapter2.onMessage((room: string) => {
        node2Received.push(room)
      })

      // Both nodes subscribe
      await adapter1.subscribe('bidirectional')
      await adapter2.subscribe('bidirectional')
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Node 1 publishes
      await adapter1.publish('bidirectional', { event: 'from-1', data: {} })

      // Node 2 publishes
      await adapter2.publish('bidirectional', { event: 'from-2', data: {} })

      await new Promise((resolve) => setTimeout(resolve, 100))

      // Node 1 receives message from node 2
      expect(node1Received).toContain('bidirectional')

      // Node 2 receives message from node 1
      expect(node2Received).toContain('bidirectional')
    })
  })
})
