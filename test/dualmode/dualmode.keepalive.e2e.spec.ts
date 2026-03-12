import { createContainer } from 'awilix'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DIContext, SSEHttpClient, type SSERoomBroadcaster } from '../../index.js'
import { createSSETestServer, type SSETestServerWithResources } from '../sseTestServerFactory.js'
import type { TestKeepaliveDualModeController } from './fixtures/testControllers.js'
import {
  TestKeepaliveDualModeModule,
  type TestKeepaliveDualModeModuleDependencies,
} from './fixtures/testModules.js'

/**
 * Dual-Mode KeepAlive E2E Tests
 *
 * These tests verify that dual-mode controllers correctly handle keepAlive SSE
 * sessions with room support while also serving sync (JSON) requests on the same route.
 *
 * This is a regression test for a bug where `asDualModeControllerClass` did not
 * support the `rooms` option, so `roomBroadcaster` was never injected into
 * dual-mode controllers. As a result, `session.rooms.join()` and
 * `broadcastToRoom()` would fail at runtime.
 */

describe('Dual-Mode KeepAlive SSE with Rooms', () => {
  let server: SSETestServerWithResources<{
    context: DIContext<TestKeepaliveDualModeModuleDependencies, object>
  }>
  let context: DIContext<TestKeepaliveDualModeModuleDependencies, object>

  beforeEach(async () => {
    const container = createContainer<TestKeepaliveDualModeModuleDependencies>({
      injectionMode: 'PROXY',
    })
    context = new DIContext<TestKeepaliveDualModeModuleDependencies, object>(
      container,
      { isTestMode: true },
      {},
    )
    context.registerDependencies({ modules: [new TestKeepaliveDualModeModule()] }, undefined)

    server = await createSSETestServer(
      (app) => {
        context.registerDualModeRoutes(app)
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

  function getController(): TestKeepaliveDualModeController {
    return server.resources.context.diContainer.resolve<TestKeepaliveDualModeController>(
      'testKeepaliveDualModeController',
    )
  }

  function getBroadcaster(): SSERoomBroadcaster {
    return server.resources.context.diContainer.resolve<SSERoomBroadcaster>('sseRoomBroadcaster')
  }

  it(
    'returns JSON for sync requests on a keepAlive dual-mode route',
    { timeout: 10000 },
    async () => {
      const response = await server.app.inject({
        method: 'get',
        url: '/api/dashboard/updates',
        headers: {
          accept: 'application/json',
        },
      })

      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain('application/json')

      const body = JSON.parse(response.body)
      expect(body).toEqual({
        status: 'ok',
        activeConnections: 0,
      })
    },
  )

  it(
    'establishes a keepAlive SSE connection and receives pushed events',
    { timeout: 10000 },
    async () => {
      const controller = getController()

      const { client, serverConnection } = await SSEHttpClient.connect(
        server.baseUrl,
        '/api/dashboard/updates',
        {
          awaitServerConnection: { controller },
        },
      )

      expect(client.response.ok).toBe(true)
      expect(client.response.headers.get('content-type')).toContain('text/event-stream')
      expect(controller.connectionSpy.isConnected(serverConnection.id)).toBe(true)

      // Push events from server
      const eventsPromise = client.collectEvents(2)

      await controller.testPushUpdate(serverConnection.id, {
        type: 'metric',
        value: 42,
      })
      await controller.testPushUpdate(serverConnection.id, {
        type: 'alert',
        value: 100,
      })

      const events = await eventsPromise
      expect(events).toHaveLength(2)
      expect(events[0]!.event).toBe('update')
      expect(JSON.parse(events[0]!.data)).toEqual({ type: 'metric', value: 42 })
      expect(events[1]!.event).toBe('update')
      expect(JSON.parse(events[1]!.data)).toEqual({ type: 'alert', value: 100 })

      client.close()
    },
  )

  it(
    'sync requests work while a keepAlive SSE connection is active',
    { timeout: 10000 },
    async () => {
      const controller = getController()

      // Establish a keepAlive SSE connection
      const { client: sseClient, serverConnection } = await SSEHttpClient.connect(
        server.baseUrl,
        '/api/dashboard/updates',
        {
          awaitServerConnection: { controller },
        },
      )

      expect(controller.connectionSpy.isConnected(serverConnection.id)).toBe(true)

      // While SSE is connected, make a sync JSON request to the same route
      const response = await server.app.inject({
        method: 'get',
        url: '/api/dashboard/updates',
        headers: {
          accept: 'application/json',
        },
      })

      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain('application/json')

      const body = JSON.parse(response.body)
      expect(body.status).toBe('ok')
      // The sync handler should report 1 active SSE connection
      expect(body.activeConnections).toBe(1)

      // SSE connection should still work after the sync request
      const eventsPromise = sseClient.collectEvents(1)
      await controller.testPushUpdate(serverConnection.id, {
        type: 'check',
        value: 1,
      })
      const events = await eventsPromise
      expect(events).toHaveLength(1)
      expect(JSON.parse(events[0]!.data)).toEqual({ type: 'check', value: 1 })

      sseClient.close()
    },
  )

  it('SSE connection joins a room and receives room broadcasts', { timeout: 10000 }, async () => {
    const controller = getController()

    // Connect with a dashboardId to join a room
    const { client, serverConnection } = await SSEHttpClient.connect(
      server.baseUrl,
      '/api/dashboard/updates',
      {
        query: { dashboardId: 'dash-1' },
        awaitServerConnection: { controller },
      },
    )

    expect(controller.connectionSpy.isConnected(serverConnection.id)).toBe(true)

    // Broadcast to the room via the controller
    const eventsPromise = client.collectEvents(1)
    await controller.testBroadcastToRoom('dashboard:dash-1', {
      type: 'room-update',
      value: 42,
    })

    const events = await eventsPromise
    expect(events).toHaveLength(1)
    expect(events[0]!.event).toBe('update')
    expect(JSON.parse(events[0]!.data)).toEqual({ type: 'room-update', value: 42 })

    client.close()
  })

  it(
    'SSE connection receives room broadcasts via SSERoomBroadcaster directly',
    { timeout: 10000 },
    async () => {
      const controller = getController()
      const broadcaster = getBroadcaster()

      // Connect with a dashboardId to join a room
      const { client, serverConnection } = await SSEHttpClient.connect(
        server.baseUrl,
        '/api/dashboard/updates',
        {
          query: { dashboardId: 'dash-2' },
          awaitServerConnection: { controller },
        },
      )

      expect(controller.connectionSpy.isConnected(serverConnection.id)).toBe(true)

      // Broadcast via the SSERoomBroadcaster (simulates external service broadcasting)
      const eventsPromise = client.collectEvents(1)
      await broadcaster.broadcastMessage('dashboard:dash-2', {
        event: 'update',
        data: { type: 'external', value: 99 },
      })

      const events = await eventsPromise
      expect(events).toHaveLength(1)
      expect(events[0]!.event).toBe('update')
      expect(JSON.parse(events[0]!.data)).toEqual({ type: 'external', value: 99 })

      client.close()
    },
  )

  it('room broadcast only reaches connections in that room', { timeout: 10000 }, async () => {
    const controller = getController()

    // Connect two clients to different rooms
    const { client: client1 } = await SSEHttpClient.connect(
      server.baseUrl,
      '/api/dashboard/updates',
      {
        query: { dashboardId: 'room-a' },
        awaitServerConnection: { controller },
      },
    )

    const { client: client2 } = await SSEHttpClient.connect(
      server.baseUrl,
      '/api/dashboard/updates',
      {
        query: { dashboardId: 'room-b' },
        awaitServerConnection: { controller },
      },
    )

    // Broadcast only to room-a
    const events1Promise = client1.collectEvents(1)
    await controller.testBroadcastToRoom('dashboard:room-a', {
      type: 'room-a-only',
      value: 1,
    })

    const events1 = await events1Promise
    expect(events1).toHaveLength(1)
    expect(JSON.parse(events1[0]!.data)).toEqual({ type: 'room-a-only', value: 1 })

    // Now broadcast to room-b and verify client2 gets it
    const events2Promise = client2.collectEvents(1)
    await controller.testBroadcastToRoom('dashboard:room-b', {
      type: 'room-b-only',
      value: 2,
    })

    const events2 = await events2Promise
    expect(events2).toHaveLength(1)
    expect(JSON.parse(events2[0]!.data)).toEqual({ type: 'room-b-only', value: 2 })

    client1.close()
    client2.close()
  })

  it(
    'multiple concurrent keepAlive SSE connections work alongside sync requests',
    { timeout: 10000 },
    async () => {
      const controller = getController()

      // Establish two keepAlive SSE connections
      const { client: client1, serverConnection: conn1 } = await SSEHttpClient.connect(
        server.baseUrl,
        '/api/dashboard/updates',
        {
          awaitServerConnection: { controller },
        },
      )

      const { client: client2, serverConnection: conn2 } = await SSEHttpClient.connect(
        server.baseUrl,
        '/api/dashboard/updates',
        {
          awaitServerConnection: { controller },
        },
      )

      expect(controller.connectionSpy.isConnected(conn1.id)).toBe(true)
      expect(controller.connectionSpy.isConnected(conn2.id)).toBe(true)

      // Sync request should see 2 active connections
      const response = await server.app.inject({
        method: 'get',
        url: '/api/dashboard/updates',
        headers: {
          accept: 'application/json',
        },
      })

      const body = JSON.parse(response.body)
      expect(body.activeConnections).toBe(2)

      // Send different events to each connection
      const events1Promise = client1.collectEvents(1)
      const events2Promise = client2.collectEvents(1)

      await controller.testPushUpdate(conn1.id, { type: 'conn1', value: 1 })
      await controller.testPushUpdate(conn2.id, { type: 'conn2', value: 2 })

      const events1 = await events1Promise
      const events2 = await events2Promise

      expect(JSON.parse(events1[0]!.data)).toEqual({ type: 'conn1', value: 1 })
      expect(JSON.parse(events2[0]!.data)).toEqual({ type: 'conn2', value: 2 })

      // Close one connection, other should still work
      client1.close()

      // Give server time to process the disconnect
      await new Promise((resolve) => setTimeout(resolve, 100))

      const events2bPromise = client2.collectEvents(1)
      await controller.testPushUpdate(conn2.id, { type: 'still-alive', value: 3 })
      const events2b = await events2bPromise
      expect(JSON.parse(events2b[0]!.data)).toEqual({ type: 'still-alive', value: 3 })

      client2.close()
    },
  )

  it('broadcast reaches all keepAlive SSE connections', { timeout: 10000 }, async () => {
    const controller = getController()

    const { client: client1 } = await SSEHttpClient.connect(
      server.baseUrl,
      '/api/dashboard/updates',
      {
        awaitServerConnection: { controller },
      },
    )

    const { client: client2 } = await SSEHttpClient.connect(
      server.baseUrl,
      '/api/dashboard/updates',
      {
        awaitServerConnection: { controller },
      },
    )

    const events1Promise = client1.collectEvents(1)
    const events2Promise = client2.collectEvents(1)

    await controller.testBroadcastUpdate({ type: 'global', value: 999 })

    const events1 = await events1Promise
    const events2 = await events2Promise

    expect(JSON.parse(events1[0]!.data)).toEqual({ type: 'global', value: 999 })
    expect(JSON.parse(events2[0]!.data)).toEqual({ type: 'global', value: 999 })

    client1.close()
    client2.close()
  })
})
