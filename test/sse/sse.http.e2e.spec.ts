import { setTimeout as delay } from 'node:timers/promises'
import { createContainer } from 'awilix'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DIContext, SSEHttpClient, SSETestServer } from '../../index.js'
import type { TestSSEController } from './fixtures/testControllers.js'
import {
  TestAuthSSEModule,
  TestChannelSSEModule,
  TestPostSSEModule,
  TestSSEModule,
  type TestSSEModuleDependencies,
} from './fixtures/testModules.js'

/**
 * SSE E2E tests using SSEHttpClient (real HTTP connections).
 *
 * These tests use actual HTTP connections via fetch(), suitable for:
 * - Long-lived SSE connections (notifications, live feeds)
 * - Testing real network behavior
 * - Testing connection lifecycle (connect/disconnect events)
 */

describe('SSE HTTP E2E (long-lived connections)', () => {
  let server: SSETestServer<{ context: DIContext<TestSSEModuleDependencies, object> }>
  let context: DIContext<TestSSEModuleDependencies, object>

  beforeEach(async () => {
    // Setup context with isTestMode to enable connection spying
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<TestSSEModuleDependencies, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestSSEModule()] }, undefined)

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

  function getController(): TestSSEController {
    return server.resources.context.diContainer.cradle.testSSEController
  }

  it(
    'receives multiple server-sent events over a long-lived connection',
    { timeout: 10000 },
    async () => {
      const controller = getController()

      // Connect with awaitServerConnection to eliminate race condition
      const { client, serverConnection } = await SSEHttpClient.connect(
        server.baseUrl,
        '/api/notifications/stream',
        {
          query: { userId: 'test-user' },
          awaitServerConnection: { controller },
        },
      )

      expect(client.response.ok).toBe(true)
      expect(client.response.headers.get('content-type')).toContain('text/event-stream')
      expect(controller.connectionSpy.isConnected(serverConnection.id)).toBe(true)

      // Start collecting events in the background
      const eventsPromise = client.collectEvents(3)

      // Send multiple events from server
      await controller.testSendEvent(serverConnection.id, {
        event: 'notification',
        data: { id: '1', message: 'First event' },
      })

      await controller.testSendEvent(serverConnection.id, {
        event: 'notification',
        data: { id: '2', message: 'Second event' },
      })

      await controller.testSendEvent(serverConnection.id, {
        event: 'notification',
        data: { id: '3', message: 'Third event' },
      })

      // Wait for collected events
      const events = await eventsPromise

      expect(events).toHaveLength(3)
      expect(JSON.parse(events[0]!.data)).toEqual({ id: '1', message: 'First event' })
      expect(JSON.parse(events[1]!.data)).toEqual({ id: '2', message: 'Second event' })
      expect(JSON.parse(events[2]!.data)).toEqual({ id: '3', message: 'Third event' })

      controller.completeHandler(serverConnection.id)
      client.close()
    },
  )

  it('handles interleaved events with delays', { timeout: 10000 }, async () => {
    const controller = getController()

    const { client, serverConnection } = await SSEHttpClient.connect(
      server.baseUrl,
      '/api/notifications/stream',
      {
        query: { userId: 'delayed-user' },
        awaitServerConnection: { controller },
      },
    )

    const eventsPromise = client.collectEvents(3)

    // Send events with delays between them
    await controller.testSendEvent(serverConnection.id, {
      event: 'notification',
      data: { id: '1', message: 'Immediate' },
    })

    await delay(100)

    await controller.testSendEvent(serverConnection.id, {
      event: 'notification',
      data: { id: '2', message: 'After 100ms' },
    })

    await delay(200)

    await controller.testSendEvent(serverConnection.id, {
      event: 'notification',
      data: { id: '3', message: 'After 200ms more' },
    })

    const events = await eventsPromise
    expect(events).toHaveLength(3)
    expect(events.map((e) => JSON.parse(e.data).message)).toEqual([
      'Immediate',
      'After 100ms',
      'After 200ms more',
    ])

    controller.completeHandler(serverConnection.id)
    client.close()
  })

  it('supports multiple concurrent connections', { timeout: 10000 }, async () => {
    const controller = getController()

    // Connect two clients - predicate-based waitForConnection allows multiple connections
    const { client: client1, serverConnection: conn1 } = await SSEHttpClient.connect(
      server.baseUrl,
      '/api/notifications/stream',
      {
        query: { userId: 'user-1' },
        awaitServerConnection: { controller },
      },
    )
    const { client: client2, serverConnection: conn2 } = await SSEHttpClient.connect(
      server.baseUrl,
      '/api/notifications/stream',
      {
        query: { userId: 'user-2' },
        awaitServerConnection: { controller },
      },
    )

    expect(controller.testGetConnectionCount()).toBe(2)
    expect(conn1.id).not.toBe(conn2.id)

    const events1Promise = client1.collectEvents(1)
    const events2Promise = client2.collectEvents(1)

    // Send different events to each
    await controller.testSendEvent(conn1.id, {
      event: 'notification',
      data: { id: '1', message: 'For user 1' },
    })
    await controller.testSendEvent(conn2.id, {
      event: 'notification',
      data: { id: '2', message: 'For user 2' },
    })

    const [events1, events2] = await Promise.all([events1Promise, events2Promise])

    expect(JSON.parse(events1[0]!.data).message).toBe('For user 1')
    expect(JSON.parse(events2[0]!.data).message).toBe('For user 2')

    controller.completeHandler(conn1.id)
    controller.completeHandler(conn2.id)
    client1.close()
    client2.close()
  })

  it('handles broadcast to all connections', { timeout: 10000 }, async () => {
    const controller = getController()

    // Connect three clients
    const connections = [
      await SSEHttpClient.connect(server.baseUrl, '/api/notifications/stream', {
        query: { userId: 'u1' },
        awaitServerConnection: { controller },
      }),
      await SSEHttpClient.connect(server.baseUrl, '/api/notifications/stream', {
        query: { userId: 'u2' },
        awaitServerConnection: { controller },
      }),
      await SSEHttpClient.connect(server.baseUrl, '/api/notifications/stream', {
        query: { userId: 'u3' },
        awaitServerConnection: { controller },
      }),
    ]

    expect(controller.testGetConnectionCount()).toBe(3)

    const eventsPromises = connections.map((c) => c.client.collectEvents(1))

    // Broadcast to all
    const sentCount = await controller.testBroadcast({
      event: 'notification',
      data: { id: 'broadcast', message: 'Hello everyone!' },
    })

    expect(sentCount).toBe(3)

    // All clients should receive the broadcast
    const allEvents = await Promise.all(eventsPromises)
    for (const events of allEvents) {
      expect(JSON.parse(events[0]!.data).message).toBe('Hello everyone!')
    }

    // Cleanup
    for (const { client, serverConnection } of connections) {
      controller.completeHandler(serverConnection.id)
      client.close()
    }
  })

  it('handles broadcastIf with predicate', { timeout: 10000 }, async () => {
    const controller = getController()

    // Connect two clients with different contexts
    const { client: vipClient, serverConnection: vipConn } = await SSEHttpClient.connect(
      server.baseUrl,
      '/api/notifications/stream',
      {
        query: { userId: 'vip-user' },
        awaitServerConnection: { controller },
      },
    )
    const { client: regularClient, serverConnection: regularConn } = await SSEHttpClient.connect(
      server.baseUrl,
      '/api/notifications/stream',
      {
        query: { userId: 'regular-user' },
        awaitServerConnection: { controller },
      },
    )

    const vipEventsPromise = vipClient.collectEvents(1, 2000)

    // Broadcast only to VIP users
    const sentCount = await controller.testBroadcastIf(
      { event: 'notification', data: { id: 'vip', message: 'VIP only!' } },
      (conn) => (conn.context as { userId?: string })?.userId?.startsWith('vip') ?? false,
    )

    expect(sentCount).toBe(1)

    const vipEvents = await vipEventsPromise
    expect(JSON.parse(vipEvents[0]!.data).message).toBe('VIP only!')

    // Regular client should not have received the event (we won't wait for it)

    controller.completeHandler(vipConn.id)
    controller.completeHandler(regularConn.id)
    vipClient.close()
    regularClient.close()
  })

  it('properly tracks connection count', { timeout: 10000 }, async () => {
    const controller = getController()

    expect(controller.testGetConnectionCount()).toBe(0)

    const { client: client1, serverConnection: conn1 } = await SSEHttpClient.connect(
      server.baseUrl,
      '/api/notifications/stream',
      {
        query: { userId: 'u1' },
        awaitServerConnection: { controller },
      },
    )
    expect(controller.testGetConnectionCount()).toBe(1)

    const { client: client2, serverConnection: conn2 } = await SSEHttpClient.connect(
      server.baseUrl,
      '/api/notifications/stream',
      {
        query: { userId: 'u2' },
        awaitServerConnection: { controller },
      },
    )
    expect(controller.testGetConnectionCount()).toBe(2)

    // Close one client
    controller.completeHandler(conn1.id)
    controller.testCloseConnection(conn1.id)
    client1.close()

    await controller.connectionSpy.waitForDisconnection(conn1.id)
    expect(controller.testGetConnectionCount()).toBe(1)

    // Close remaining
    controller.completeHandler(conn2.id)
    client2.close()
  })

  it('server can close connection', { timeout: 10000 }, async () => {
    const controller = getController()

    const { client, serverConnection } = await SSEHttpClient.connect(
      server.baseUrl,
      '/api/notifications/stream',
      {
        query: { userId: 'will-be-closed' },
        awaitServerConnection: { controller },
      },
    )

    // Send an event first
    await controller.testSendEvent(serverConnection.id, {
      event: 'notification',
      data: { id: '1', message: 'Before close' },
    })

    // Server initiates close
    controller.completeHandler(serverConnection.id)
    const closed = controller.testCloseConnection(serverConnection.id)
    expect(closed).toBe(true)

    // Connection should be removed
    expect(controller.testGetConnectionCount()).toBe(0)

    client.close()
  })
})

describe('SSE HTTP E2E (error handling)', () => {
  let server: SSETestServer<{ context: DIContext<TestSSEModuleDependencies, object> }>
  let context: DIContext<TestSSEModuleDependencies, object>

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<TestSSEModuleDependencies, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestSSEModule()] }, undefined)

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

  function getController(): TestSSEController {
    return server.resources.context.diContainer.cradle.testSSEController
  }

  it('handles sending to non-existent connection gracefully', { timeout: 10000 }, async () => {
    const controller = getController()

    // Try to send to non-existent connection
    const result = await controller.testSendEvent('non-existent-id', {
      event: 'test',
      data: { message: 'Should not work' },
    })

    expect(result).toBe(false)
  })

  it('handles closing non-existent connection gracefully', { timeout: 10000 }, () => {
    const controller = getController()

    const result = controller.testCloseConnection('non-existent-id')
    expect(result).toBe(false)
  })

  it('handles client disconnect during event sending', { timeout: 10000 }, async () => {
    const controller = getController()

    const { client, serverConnection } = await SSEHttpClient.connect(
      server.baseUrl,
      '/api/notifications/stream',
      {
        query: { userId: 'disconnect-test' },
        awaitServerConnection: { controller },
      },
    )

    // Client disconnects abruptly
    client.close()

    // Wait a bit for disconnect to propagate
    await delay(100)

    // Sending should now fail or handle gracefully
    const result = await controller.testSendEvent(serverConnection.id, {
      event: 'notification',
      data: { id: '1', message: 'After disconnect' },
    })

    // Should return false since connection is dead
    expect(result).toBe(false)

    controller.completeHandler(serverConnection.id)
  })
})

describe('SSE HTTP E2E (serialization)', () => {
  let server: SSETestServer<{ context: DIContext<TestSSEModuleDependencies, object> }>
  let context: DIContext<TestSSEModuleDependencies, object>

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<TestSSEModuleDependencies, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestSSEModule()] }, undefined)

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

  function getController(): TestSSEController {
    return server.resources.context.diContainer.cradle.testSSEController
  }

  it('serializes various JSON data types correctly', { timeout: 10000 }, async () => {
    const controller = getController()

    const { client, serverConnection } = await SSEHttpClient.connect(
      server.baseUrl,
      '/api/notifications/stream',
      {
        query: { userId: 'serialization-test' },
        awaitServerConnection: { controller },
      },
    )

    // Test data covering: nested objects, arrays, special characters, null, numbers, booleans
    const testData = {
      id: 'comprehensive-1',
      message: 'Special: "quotes", \'apostrophes\', newlines\nand\ttabs, unicode: 日本語 🎉',
      metadata: {
        nested: { deeply: { value: 42, array: [1, 2, 3] } },
        tags: ['a', 'b', 'c'],
      },
      optionalField: null,
      integer: 42,
      float: Math.PI,
      negative: -100,
      scientific: 1.5e10,
      isActive: true,
      isDeleted: false,
    }

    const eventsPromise = client.collectEvents(1)

    await controller.testSendEvent(serverConnection.id, {
      event: 'notification',
      data: testData,
    })

    const events = await eventsPromise
    const received = JSON.parse(events[0]!.data)

    expect(received).toEqual(testData)

    controller.completeHandler(serverConnection.id)
    client.close()
  })
})

describe('SSE HTTP E2E (event metadata)', () => {
  let server: SSETestServer<{ context: DIContext<TestSSEModuleDependencies, object> }>
  let context: DIContext<TestSSEModuleDependencies, object>

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<TestSSEModuleDependencies, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestSSEModule()] }, undefined)

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

  function getController(): TestSSEController {
    return server.resources.context.diContainer.cradle.testSSEController
  }

  it('sends event with custom ID', { timeout: 10000 }, async () => {
    const controller = getController()

    const { client, serverConnection } = await SSEHttpClient.connect(
      server.baseUrl,
      '/api/notifications/stream',
      {
        query: { userId: 'event-id-test' },
        awaitServerConnection: { controller },
      },
    )

    const eventsPromise = client.collectEvents(1)

    await controller.testSendEvent(serverConnection.id, {
      event: 'notification',
      data: { id: '1', message: 'With custom ID' },
      id: 'custom-event-id-123',
    })

    const events = await eventsPromise
    expect(events[0]!.id).toBe('custom-event-id-123')

    controller.completeHandler(serverConnection.id)
    client.close()
  })

  it('sends events with different event types', { timeout: 10000 }, async () => {
    const controller = getController()

    const { client, serverConnection } = await SSEHttpClient.connect(
      server.baseUrl,
      '/api/notifications/stream',
      {
        query: { userId: 'event-types-test' },
        awaitServerConnection: { controller },
      },
    )

    const eventsPromise = client.collectEvents(3)

    // Send events with different event types
    await controller.testSendEvent(serverConnection.id, {
      event: 'notification',
      data: { id: '1', message: 'Notification' },
    })

    await controller.testSendEvent(serverConnection.id, {
      event: 'alert',
      data: { id: '2', message: 'Alert' },
    })

    await controller.testSendEvent(serverConnection.id, {
      event: 'system',
      data: { id: '3', message: 'System' },
    })

    const events = await eventsPromise
    expect(events[0]!.event).toBe('notification')
    expect(events[1]!.event).toBe('alert')
    expect(events[2]!.event).toBe('system')

    controller.completeHandler(serverConnection.id)
    client.close()
  })

  it('sends event without explicit event type (uses message)', { timeout: 10000 }, async () => {
    const controller = getController()

    const { client, serverConnection } = await SSEHttpClient.connect(
      server.baseUrl,
      '/api/notifications/stream',
      {
        query: { userId: 'no-event-type' },
        awaitServerConnection: { controller },
      },
    )

    const eventsPromise = client.collectEvents(1)

    // Send without event type
    await controller.testSendEvent(serverConnection.id, {
      data: { id: '1', message: 'No event type' },
    })

    const events = await eventsPromise
    // Event type should be undefined when not specified
    expect(events[0]!.event).toBeUndefined()
    expect(JSON.parse(events[0]!.data).message).toBe('No event type')

    controller.completeHandler(serverConnection.id)
    client.close()
  })
})

describe('SSE HTTP E2E (connection lifecycle)', () => {
  let server: SSETestServer<{ context: DIContext<TestSSEModuleDependencies, object> }>
  let context: DIContext<TestSSEModuleDependencies, object>

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<TestSSEModuleDependencies, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestSSEModule()] }, undefined)

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

  function getController(): TestSSEController {
    return server.resources.context.diContainer.cradle.testSSEController
  }

  it('tracks connection events and isConnected status in spy', { timeout: 10000 }, async () => {
    const controller = getController()

    const { client, serverConnection } = await SSEHttpClient.connect(
      server.baseUrl,
      '/api/notifications/stream',
      {
        query: { userId: 'lifecycle-test' },
        awaitServerConnection: { controller },
      },
    )

    // Check connection event was recorded and isConnected returns true
    const events = controller.connectionSpy.getEvents()
    const connectEvent = events.find(
      (e) => e.type === 'connect' && e.connectionId === serverConnection.id,
    )
    expect(connectEvent).toBeDefined()
    expect(connectEvent!.connection).toBeDefined()
    expect(controller.connectionSpy.isConnected(serverConnection.id)).toBe(true)

    controller.completeHandler(serverConnection.id)
    controller.testCloseConnection(serverConnection.id)
    client.close()

    await controller.connectionSpy.waitForDisconnection(serverConnection.id)

    // Check disconnect event was recorded and isConnected returns false
    const allEvents = controller.connectionSpy.getEvents()
    const disconnectEvent = allEvents.find(
      (e) => e.type === 'disconnect' && e.connectionId === serverConnection.id,
    )
    expect(disconnectEvent).toBeDefined()
    expect(controller.connectionSpy.isConnected(serverConnection.id)).toBe(false)
  })

  it('connection has context and metadata', { timeout: 10000 }, async () => {
    const controller = getController()

    const { client, serverConnection } = await SSEHttpClient.connect(
      server.baseUrl,
      '/api/notifications/stream',
      {
        query: { userId: 'context-user-123' },
        awaitServerConnection: { controller },
      },
    )

    // Check metadata
    expect(serverConnection.id).toBeDefined()
    expect(typeof serverConnection.id).toBe('string')
    expect(serverConnection.connectedAt).toBeInstanceOf(Date)
    expect(serverConnection.request).toBeDefined()
    expect(serverConnection.reply).toBeDefined()

    // Check context (handler sets context.userId from query param)
    expect(serverConnection.context).toBeDefined()
    expect((serverConnection.context as { userId?: string }).userId).toBe('context-user-123')

    controller.completeHandler(serverConnection.id)
    client.close()
  })
})

describe('SSE HTTP E2E (SSEConnectionSpy edge cases)', () => {
  let server: SSETestServer<{ context: DIContext<TestSSEModuleDependencies, object> }>
  let context: DIContext<TestSSEModuleDependencies, object>

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<TestSSEModuleDependencies, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestSSEModule()] }, undefined)

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

  function getController(): TestSSEController {
    return server.resources.context.diContainer.cradle.testSSEController
  }

  it('waitForConnection times out when no connection arrives', { timeout: 10000 }, async () => {
    const controller = getController()

    // Wait for a connection that never comes - should timeout
    await expect(controller.connectionSpy.waitForConnection({ timeout: 100 })).rejects.toThrow(
      'Timeout waiting for connection after 100ms',
    )
  })

  it('waitForDisconnection times out when connection stays open', { timeout: 10000 }, async () => {
    const controller = getController()

    const { client, serverConnection } = await SSEHttpClient.connect(
      server.baseUrl,
      '/api/notifications/stream',
      {
        query: { userId: 'timeout-test' },
        awaitServerConnection: { controller },
      },
    )

    // Wait for disconnection but don't close the connection - should timeout
    await expect(
      controller.connectionSpy.waitForDisconnection(serverConnection.id, { timeout: 100 }),
    ).rejects.toThrow('Timeout waiting for disconnection after 100ms')

    // Clean up
    controller.completeHandler(serverConnection.id)
    client.close()
  })

  it('clear() cancels pending waiters and resets state', { timeout: 10000 }, async () => {
    const controller = getController()

    // Start waiting for connection (will never arrive)
    const waitPromise = controller.connectionSpy.waitForConnection({ timeout: 5000 })

    // Give the waiter time to register
    await delay(50)

    // Clear the spy - should reject the pending waiter
    controller.connectionSpy.clear()

    await expect(waitPromise).rejects.toThrow('ConnectionSpy was cleared')

    // Events should be empty after clear
    expect(controller.connectionSpy.getEvents()).toHaveLength(0)
  })

  it('clear() cancels pending disconnection waiters', { timeout: 10000 }, async () => {
    const controller = getController()

    const { client, serverConnection } = await SSEHttpClient.connect(
      server.baseUrl,
      '/api/notifications/stream',
      {
        query: { userId: 'clear-test' },
        awaitServerConnection: { controller },
      },
    )

    // Start waiting for disconnection
    const waitPromise = controller.connectionSpy.waitForDisconnection(serverConnection.id, {
      timeout: 5000,
    })

    // Give the waiter time to register
    await delay(50)

    // Clear the spy
    controller.connectionSpy.clear()

    await expect(waitPromise).rejects.toThrow('ConnectionSpy was cleared')

    controller.completeHandler(serverConnection.id)
    client.close()
  })

  it(
    'waitForDisconnection resolves immediately if already disconnected',
    { timeout: 10000 },
    async () => {
      const controller = getController()

      const { client, serverConnection } = await SSEHttpClient.connect(
        server.baseUrl,
        '/api/notifications/stream',
        {
          query: { userId: 'already-disconnected' },
          awaitServerConnection: { controller },
        },
      )

      // Close the connection first
      controller.completeHandler(serverConnection.id)
      controller.testCloseConnection(serverConnection.id)
      client.close()

      // Wait for the disconnect to be processed
      await delay(100)

      // Now wait for disconnection - should resolve immediately since already disconnected
      await controller.connectionSpy.waitForDisconnection(serverConnection.id, { timeout: 100 })
      // If we get here without timeout, the test passes
    },
  )

  it(
    'waitForConnection resolves immediately if connection already exists',
    { timeout: 10000 },
    async () => {
      const controller = getController()

      // This test specifically tests waitForConnection behavior, so we use manual connection
      const client = await SSEHttpClient.connect(server.baseUrl, '/api/notifications/stream', {
        query: { userId: 'already-connected' },
      })

      // Wait for the connection to be established
      await delay(100)

      // Now waitForConnection should resolve immediately since connection exists
      const connection = await controller.connectionSpy.waitForConnection({ timeout: 100 })
      expect(connection).toBeDefined()
      expect(connection.id).toBeDefined()

      controller.completeHandler(connection.id)
      client.close()
    },
  )
})

describe('SSE HTTP E2E (authentication)', () => {
  let server: SSETestServer<{ context: DIContext<object, object> }>
  let context: DIContext<object, object>

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestAuthSSEModule()] }, undefined)

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

  it('works with real HTTP connection and auth headers', { timeout: 10000 }, async () => {
    const client = await SSEHttpClient.connect(server.baseUrl, '/api/protected/stream', {
      headers: { Authorization: 'Bearer real-token' },
    })

    expect(client.response.ok).toBe(true)
    expect(client.response.headers.get('content-type')).toContain('text/event-stream')

    // The handler sends one event and then closes the connection
    const events = await client.collectEvents(1)
    expect(events[0]!.event).toBe('data')
    expect(JSON.parse(events[0]!.data)).toEqual({ value: 'authenticated data' })

    client.close()
  })
})

describe('SSE HTTP E2E (path parameters)', () => {
  let server: SSETestServer<{ context: DIContext<object, object> }>
  let context: DIContext<object, object>

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestChannelSSEModule()] }, undefined)

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

  it('works with real HTTP connection and path params', { timeout: 10000 }, async () => {
    const client = await SSEHttpClient.connect(server.baseUrl, '/api/channels/my-channel/stream')

    expect(client.response.ok).toBe(true)

    const events = await client.collectEvents(1)
    expect(JSON.parse(events[0]!.data).content).toBe('Welcome to channel my-channel')

    client.close()
  })
})

describe('SSE HTTP E2E (awaitServerConnection option)', () => {
  let server: SSETestServer<{ context: DIContext<TestSSEModuleDependencies, object> }>
  let context: DIContext<TestSSEModuleDependencies, object>

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<TestSSEModuleDependencies, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestSSEModule()] }, undefined)

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

  function getController(): TestSSEController {
    return server.resources.context.diContainer.cradle.testSSEController
  }

  it('supports custom timeout for awaitServerConnection', { timeout: 10000 }, async () => {
    const controller = getController()

    const { client, serverConnection } = await SSEHttpClient.connect(
      server.baseUrl,
      '/api/notifications/stream',
      {
        query: { userId: 'timeout-test' },
        awaitServerConnection: { controller, timeout: 2000 },
      },
    )

    expect(serverConnection.id).toBeDefined()

    controller.completeHandler(serverConnection.id)
    client.close()
  })
})

describe('SSE HTTP E2E (large content streaming)', () => {
  let server: SSETestServer<{ context: DIContext<object, object> }>
  let context: DIContext<object, object>

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestPostSSEModule()] }, undefined)

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

  it('streams 10MB of content via real HTTP without data loss', { timeout: 10000 }, async () => {
    // 10MB total: 1000 chunks × 10KB each
    const chunkCount = 1000
    const chunkSize = 10000
    const expectedTotalBytes = chunkCount * chunkSize // 10MB

    // Use real HTTP POST request
    const response = await fetch(`${server.baseUrl}/api/large-content/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ chunkCount, chunkSize }),
    })

    expect(response.ok).toBe(true)
    expect(response.headers.get('content-type')).toContain('text/event-stream')

    // Read the entire response body
    const body = await response.text()

    // Verify body size is substantial (SSE overhead adds event:/data:/newlines)
    // Each chunk adds: "event:chunk\ndata:{...}\n\n" where data includes ~10KB content
    // Minimum expected: 10MB of content + SSE framing
    expect(body.length).toBeGreaterThan(expectedTotalBytes)

    // Parse SSE events manually
    const events: Array<{ event?: string; data: string }> = []
    const lines = body.split('\n')
    let currentEvent: { event?: string; data: string } = { data: '' }

    for (const line of lines) {
      if (line.startsWith('event:')) {
        currentEvent.event = line.slice(6).trim()
      } else if (line.startsWith('data:')) {
        currentEvent.data = line.slice(5).trim()
      } else if (line === '' && currentEvent.data) {
        events.push(currentEvent)
        currentEvent = { data: '' }
      }
    }

    const chunkEvents = events.filter((e) => e.event === 'chunk')
    const doneEvents = events.filter((e) => e.event === 'done')

    // Verify all chunks were received
    expect(chunkEvents).toHaveLength(chunkCount)
    expect(doneEvents).toHaveLength(1)

    // Verify first, middle, and last chunks for order and content integrity
    const checkIndices = [0, Math.floor(chunkCount / 2), chunkCount - 1]
    for (const i of checkIndices) {
      const data = JSON.parse(chunkEvents[i]!.data)
      expect(data.index).toBe(i)
      expect(data.content.length).toBe(chunkSize)
      expect(data.content).toContain(`[chunk-${i}]`)
    }

    // Verify done event totals
    const doneData = JSON.parse(doneEvents[0]!.data)
    expect(doneData.totalChunks).toBe(chunkCount)
    expect(doneData.totalBytes).toBe(expectedTotalBytes)
  })
})
