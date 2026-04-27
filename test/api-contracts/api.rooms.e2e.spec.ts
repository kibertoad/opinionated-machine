import { createContainer } from 'awilix'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DIContext, SSEHttpClient } from '../../index.js'
import { createSSETestServer, type SSETestServerWithResources } from '../sseTestServerFactory.js'
import type { TestApiRoomController } from './fixtures/testControllers.ts'
import {
  TestApiRoomModule,
  type TestApiRoomModuleControllers,
  type TestApiRoomModuleDependencies,
} from './fixtures/testModules.ts'

type TestContext = DIContext<TestApiRoomModuleDependencies & TestApiRoomModuleControllers, object>

describe('AbstractApiController — Rooms E2E', () => {
  let server: SSETestServerWithResources<{ context: TestContext }>
  let context: TestContext
  let controller: TestApiRoomController

  beforeEach(async () => {
    const container = createContainer<TestApiRoomModuleDependencies & TestApiRoomModuleControllers>(
      { injectionMode: 'PROXY' },
    )
    context = new DIContext<TestApiRoomModuleDependencies & TestApiRoomModuleControllers, object>(
      container,
      { isTestMode: true },
      {},
    )
    context.registerDependencies({ modules: [new TestApiRoomModule()] }, undefined)
    controller = context.diContainer.resolve<TestApiRoomController>('testApiRoomController')

    server = await createSSETestServer(
      (app) => {
        context.registerRoutes(app)
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

  it('enables rooms when configured', () => {
    expect(controller.testRoomsEnabled).toBe(true)
  })

  describe('session.rooms.join', () => {
    it(
      'joins the room derived from the path parameter on connect',
      { timeout: 10000 },
      async () => {
        const { client, serverConnection } = await SSEHttpClient.connect(
          server.baseUrl,
          '/api/rooms/general/stream',
          { awaitServerConnection: { controller } },
        )

        expect(controller.testGetConnectionsInRoom('general')).toContain(serverConnection.id)

        client.close()
      },
    )

    it('does not add the connection to unrelated rooms', { timeout: 10000 }, async () => {
      const { client, serverConnection } = await SSEHttpClient.connect(
        server.baseUrl,
        '/api/rooms/lobby/stream',
        { awaitServerConnection: { controller } },
      )

      expect(controller.testGetConnectionsInRoom('other')).not.toContain(serverConnection.id)

      client.close()
    })
  })

  describe('session.rooms.leave', () => {
    it('removes connection from a room on manual leave', { timeout: 10000 }, async () => {
      const { client, serverConnection } = await SSEHttpClient.connect(
        server.baseUrl,
        '/api/rooms/room1/stream',
        { awaitServerConnection: { controller } },
      )

      controller.testJoinRoom(serverConnection.id, ['room2', 'room3'])
      expect(controller.testGetConnectionsInRoom('room2')).toContain(serverConnection.id)

      controller.testLeaveRoom(serverConnection.id, 'room2')

      expect(controller.testGetConnectionsInRoom('room2')).not.toContain(serverConnection.id)
      expect(controller.testGetConnectionsInRoom('room3')).toContain(serverConnection.id)

      client.close()
    })
  })

  describe('auto-leave on disconnect', () => {
    it('leaves all rooms when the connection closes', { timeout: 10000 }, async () => {
      const { client, serverConnection } = await SSEHttpClient.connect(
        server.baseUrl,
        '/api/rooms/test-room/stream',
        { awaitServerConnection: { controller } },
      )

      controller.testJoinRoom(serverConnection.id, ['room2', 'room3'])
      expect(controller.testGetConnectionCountInRoom('test-room')).toBe(1)

      client.close()
      await controller.connectionSpy.waitForDisconnection(serverConnection.id)

      expect(controller.testGetConnectionCountInRoom('test-room')).toBe(0)
      expect(controller.testGetConnectionCountInRoom('room2')).toBe(0)
      expect(controller.testGetConnectionCountInRoom('room3')).toBe(0)
    })
  })

  describe('broadcastMessage', () => {
    it('delivers a message to all connections in the room', { timeout: 10000 }, async () => {
      const { client: client1 } = await SSEHttpClient.connect(
        server.baseUrl,
        '/api/rooms/chat/stream',
        { query: { userId: 'user1' }, awaitServerConnection: { controller } },
      )
      const { client: client2 } = await SSEHttpClient.connect(
        server.baseUrl,
        '/api/rooms/chat/stream',
        { query: { userId: 'user2' }, awaitServerConnection: { controller } },
      )

      expect(controller.testGetConnectionCountInRoom('chat')).toBe(2)

      const eventsPromise1 = client1.collectEvents(1, 5000)
      const eventsPromise2 = client2.collectEvents(1, 5000)

      const sent = await controller.testBroadcastToRoom('chat', 'message', {
        from: 'system',
        text: 'Hello room!',
      })
      expect(sent).toBe(2)

      const [events1, events2] = await Promise.all([eventsPromise1, eventsPromise2])
      expect(JSON.parse(events1[0]!.data)).toEqual({ from: 'system', text: 'Hello room!' })
      expect(JSON.parse(events2[0]!.data)).toEqual({ from: 'system', text: 'Hello room!' })

      client1.close()
      client2.close()
    })

    it('only sends to connections in the target room', { timeout: 10000 }, async () => {
      const { client: clientA } = await SSEHttpClient.connect(
        server.baseUrl,
        '/api/rooms/room-a/stream',
        { awaitServerConnection: { controller } },
      )
      const { client: clientB } = await SSEHttpClient.connect(
        server.baseUrl,
        '/api/rooms/room-b/stream',
        { awaitServerConnection: { controller } },
      )

      const sent = await controller.testBroadcastToRoom('room-a', 'message', {
        from: 'system',
        text: 'For room-a only',
      })
      expect(sent).toBe(1)

      clientA.close()
      clientB.close()
    })
  })
})
