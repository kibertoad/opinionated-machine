import { createContainer } from 'awilix'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DIContext, SSEHttpClient, SSETestServer } from '../../index.js'
import type { TestRoomSSEController } from './fixtures/testControllers.js'
import { TestRoomSSEModule, type TestRoomSSEModuleControllers } from './fixtures/testModules.js'

/**
 * E2E tests for SSE Rooms functionality.
 *
 * Tests room operations including:
 * - Joining/leaving rooms via session.rooms API
 * - Broadcasting to rooms via broadcastToRoom
 * - Auto-leave on disconnect
 * - Room queries (getConnectionsInRoom, getRooms, etc.)
 */
describe('SSE Rooms E2E', () => {
  let server: SSETestServer<{
    context: DIContext<TestRoomSSEModuleControllers, object>
  }>
  let context: DIContext<TestRoomSSEModuleControllers, object>
  let controller: TestRoomSSEController

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<TestRoomSSEModuleControllers, object>(
      container,
      { isTestMode: true },
      {},
    )
    context.registerDependencies({ modules: [new TestRoomSSEModule()] }, undefined)

    controller = context.diContainer.resolve<TestRoomSSEController>('testRoomSSEController')

    server = await SSETestServer.create(
      (app) => {
        context.registerSSERoutes(app)
      },
      {
        configureApp: (app) => {
          app.setValidatorCompiler(validatorCompiler)
          app.setSerializerCompiler(serializerCompiler)
        },
        setup: () => ({ context }),
      },
    )
  })

  afterEach(async () => {
    await server.resources.context.destroy()
    await server.close()
  })

  describe('room manager initialization', () => {
    it('should enable rooms when configured', () => {
      expect(controller.testRoomsEnabled).toBe(true)
    })
  })

  describe('session.rooms API', () => {
    it('should join room from path parameter', { timeout: 10000 }, async () => {
      // Connect to room 'general'
      const { client, serverConnection } = await SSEHttpClient.connect(
        server.baseUrl,
        '/api/rooms/general/stream',
        {
          query: { userId: 'user1' },
          awaitServerConnection: { controller },
        },
      )

      expect(controller.testGetRooms(serverConnection.id)).toContain('general')
      expect(controller.testGetConnectionsInRoom('general')).toContain(serverConnection.id)

      client.close()
    })

    it('should auto-join self room by default', { timeout: 10000 }, async () => {
      const { client, serverConnection } = await SSEHttpClient.connect(
        server.baseUrl,
        '/api/rooms/general/stream',
        { awaitServerConnection: { controller } },
      )

      // Connection should be in self-room (same as connection ID)
      expect(controller.testGetRooms(serverConnection.id)).toContain(serverConnection.id)

      client.close()
    })

    it('should join multiple rooms', { timeout: 10000 }, async () => {
      const { client, serverConnection } = await SSEHttpClient.connect(
        server.baseUrl,
        '/api/rooms/lobby/stream',
        { awaitServerConnection: { controller } },
      )

      // Manually join additional rooms
      controller.testJoinRoom(serverConnection.id, ['premium', 'beta'])

      const rooms = controller.testGetRooms(serverConnection.id)
      expect(rooms).toContain('lobby')
      expect(rooms).toContain('premium')
      expect(rooms).toContain('beta')

      client.close()
    })

    it('should leave rooms manually', { timeout: 10000 }, async () => {
      const { client, serverConnection } = await SSEHttpClient.connect(
        server.baseUrl,
        '/api/rooms/room1/stream',
        { awaitServerConnection: { controller } },
      )

      controller.testJoinRoom(serverConnection.id, ['room2', 'room3'])
      expect(controller.testGetRooms(serverConnection.id)).toContain('room2')

      controller.testLeaveRoom(serverConnection.id, 'room2')

      const rooms = controller.testGetRooms(serverConnection.id)
      expect(rooms).not.toContain('room2')
      expect(rooms).toContain('room3')

      client.close()
    })
  })

  describe('broadcastToRoom', () => {
    it('should count all connections in a room', { timeout: 10000 }, async () => {
      // Connect two users to the same room
      const { client: client1, serverConnection: conn1 } = await SSEHttpClient.connect(
        server.baseUrl,
        '/api/rooms/chat/stream',
        {
          query: { userId: 'user1' },
          awaitServerConnection: { controller },
        },
      )

      const { client: client2, serverConnection: conn2 } = await SSEHttpClient.connect(
        server.baseUrl,
        '/api/rooms/chat/stream',
        {
          query: { userId: 'user2' },
          awaitServerConnection: { controller },
        },
      )

      expect(controller.testGetConnectionCountInRoom('chat')).toBe(2)
      expect(controller.testGetConnectionsInRoom('chat')).toContain(conn1.id)
      expect(controller.testGetConnectionsInRoom('chat')).toContain(conn2.id)

      client1.close()
      client2.close()
    })

    it('should only count connections in specified room', { timeout: 10000 }, async () => {
      // User 1 in room-a
      const { client: client1, serverConnection: conn1 } = await SSEHttpClient.connect(
        server.baseUrl,
        '/api/rooms/room-a/stream',
        {
          query: { userId: 'user1' },
          awaitServerConnection: { controller },
        },
      )

      // User 2 in room-b
      const { client: client2, serverConnection: conn2 } = await SSEHttpClient.connect(
        server.baseUrl,
        '/api/rooms/room-b/stream',
        {
          query: { userId: 'user2' },
          awaitServerConnection: { controller },
        },
      )

      expect(controller.testGetConnectionsInRoom('room-a')).toContain(conn1.id)
      expect(controller.testGetConnectionsInRoom('room-a')).not.toContain(conn2.id)

      expect(controller.testGetConnectionsInRoom('room-b')).toContain(conn2.id)
      expect(controller.testGetConnectionsInRoom('room-b')).not.toContain(conn1.id)

      client1.close()
      client2.close()
    })

    it('should support except option to exclude sender', { timeout: 10000 }, async () => {
      // Connect two users to the same room
      const { client: client1 } = await SSEHttpClient.connect(
        server.baseUrl,
        '/api/rooms/chat/stream',
        {
          query: { userId: 'user1' },
          awaitServerConnection: { controller },
        },
      )

      const { client: client2, serverConnection: conn2 } = await SSEHttpClient.connect(
        server.baseUrl,
        '/api/rooms/chat/stream',
        {
          query: { userId: 'user2' },
          awaitServerConnection: { controller },
        },
      )

      // Broadcast from user2, excluding user2
      const count = await controller.testBroadcastToRoom(
        'chat',
        { event: 'message', data: { from: 'user2', text: 'Hello!' } },
        { except: conn2.id },
      )

      // Should send to 1 connection (user1), not 2
      expect(count).toBe(1)

      client1.close()
      client2.close()
    })

    it('should broadcast to multiple rooms without duplicates', { timeout: 10000 }, async () => {
      // User in both premium and beta rooms
      const { client, serverConnection: conn } = await SSEHttpClient.connect(
        server.baseUrl,
        '/api/rooms/general/stream',
        {
          query: { userId: 'user1' },
          awaitServerConnection: { controller },
        },
      )

      controller.testJoinRoom(conn.id, ['premium', 'beta'])

      // Broadcast to both rooms - should only send once to this user
      const count = await controller.testBroadcastToRoom(
        ['premium', 'beta'],
        { event: 'message', data: { from: 'system', text: 'Feature update!' } },
      )

      expect(count).toBe(1) // De-duplicated

      client.close()
    })
  })

  describe('auto-leave on disconnect', () => {
    it('should automatically leave all rooms when connection closes', { timeout: 10000 }, async () => {
      const { client, serverConnection: conn } = await SSEHttpClient.connect(
        server.baseUrl,
        '/api/rooms/test-room/stream',
        { awaitServerConnection: { controller } },
      )

      controller.testJoinRoom(conn.id, ['room2', 'room3'])
      expect(controller.testGetConnectionCountInRoom('test-room')).toBe(1)
      expect(controller.testGetConnectionCountInRoom('room2')).toBe(1)
      expect(controller.testGetConnectionCountInRoom('room3')).toBe(1)

      // Close the connection
      client.close()

      // Wait for disconnect
      await controller.connectionSpy.waitForDisconnection(conn.id)

      // All rooms should be empty
      expect(controller.testGetConnectionCountInRoom('test-room')).toBe(0)
      expect(controller.testGetConnectionCountInRoom('room2')).toBe(0)
      expect(controller.testGetConnectionCountInRoom('room3')).toBe(0)
    })
  })

  describe('room queries', () => {
    it('should return correct connection count in room', { timeout: 10000 }, async () => {
      expect(controller.testGetConnectionCountInRoom('empty-room')).toBe(0)

      const { client: client1, serverConnection: conn1 } = await SSEHttpClient.connect(
        server.baseUrl,
        '/api/rooms/counting-room/stream',
        { awaitServerConnection: { controller } },
      )

      expect(controller.testGetConnectionCountInRoom('counting-room')).toBe(1)

      const { client: client2 } = await SSEHttpClient.connect(
        server.baseUrl,
        '/api/rooms/counting-room/stream',
        { awaitServerConnection: { controller } },
      )

      expect(controller.testGetConnectionCountInRoom('counting-room')).toBe(2)

      client1.close()
      await controller.connectionSpy.waitForDisconnection(conn1.id)

      expect(controller.testGetConnectionCountInRoom('counting-room')).toBe(1)

      client2.close()
    })

    it('should return all connections in a room', { timeout: 10000 }, async () => {
      const { client: client1, serverConnection: conn1 } = await SSEHttpClient.connect(
        server.baseUrl,
        '/api/rooms/list-room/stream',
        {
          query: { userId: 'user1' },
          awaitServerConnection: { controller },
        },
      )

      const { client: client2, serverConnection: conn2 } = await SSEHttpClient.connect(
        server.baseUrl,
        '/api/rooms/list-room/stream',
        {
          query: { userId: 'user2' },
          awaitServerConnection: { controller },
        },
      )

      const connections = controller.testGetConnectionsInRoom('list-room')
      expect(connections).toHaveLength(2)
      expect(connections).toContain(conn1.id)
      expect(connections).toContain(conn2.id)

      client1.close()
      client2.close()
    })
  })

  describe('room broadcast delivery', () => {
    it('should deliver broadcast messages to connections in room', { timeout: 10000 }, async () => {
      // Connect a client and collect events
      const { client, serverConnection } = await SSEHttpClient.connect(
        server.baseUrl,
        '/api/rooms/delivery-test/stream',
        {
          query: { userId: 'receiver' },
          awaitServerConnection: { controller },
        },
      )

      // Start collecting events
      const eventsPromise = client.collectEvents(2, 5000)

      // First event: userJoined (sent automatically when connecting)
      // But we excluded self, so we need to broadcast manually

      // Broadcast a message to the room
      await controller.testBroadcastToRoom('delivery-test', {
        event: 'message',
        data: { from: 'system', text: 'Welcome!' },
      })

      await controller.testBroadcastToRoom('delivery-test', {
        event: 'message',
        data: { from: 'bot', text: 'How can I help?' },
      })

      const events = await eventsPromise

      expect(events).toHaveLength(2)
      expect(events[0]?.event).toBe('message')
      expect(JSON.parse(events[0]!.data)).toEqual({ from: 'system', text: 'Welcome!' })
      expect(events[1]?.event).toBe('message')
      expect(JSON.parse(events[1]!.data)).toEqual({ from: 'bot', text: 'How can I help?' })

      client.close()
    })
  })
})
