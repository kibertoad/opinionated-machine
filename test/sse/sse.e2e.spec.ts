import { createContainer } from 'awilix'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  connectSSE,
  createSSETestServer,
  DIContext,
  injectPayloadSSE,
  injectSSE,
  parseSSEEvents,
  type SSETestServer,
} from '../../index.js'
import {
  asyncReconnectStreamContract,
  authenticatedStreamContract,
  channelStreamContract,
  chatCompletionContract,
  reconnectStreamContract,
} from './fixtures/testContracts.js'
import type { TestSSEController } from './fixtures/testControllers.js'
import {
  TestAuthSSEModule,
  TestChannelSSEModule,
  TestPostSSEModule,
  TestReconnectSSEModule,
  type TestReconnectSSEModuleDependencies,
  TestSSEModule,
  type TestSSEModuleDependencies,
} from './fixtures/testModules.js'

describe('SSE E2E (long-lived connections)', () => {
  let server: SSETestServer<{ context: DIContext<TestSSEModuleDependencies, object> }>
  let context: DIContext<TestSSEModuleDependencies, object>

  beforeEach(async () => {
    // Setup context with isTestMode to enable connection spying
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<TestSSEModuleDependencies, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestSSEModule()] }, undefined)

    server = await createSSETestServer(
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

      // Connect using our helper - returns when headers received (connection established)
      const clientConnection = await connectSSE(server.baseUrl, '/api/notifications/stream', {
        query: { userId: 'test-user' },
      })

      // Headers received = connection established
      expect(clientConnection.response.ok).toBe(true)
      expect(clientConnection.response.headers.get('content-type')).toContain('text/event-stream')

      // Start collecting events - this keeps the connection alive by reading from the stream
      const eventsPromise = clientConnection.collectEvents(3)

      // Wait for the connection to be registered on the server side
      const serverConnection = await controller.connectionSpy.waitForConnection()
      const connectionId = serverConnection.id

      // Verify connection is active
      expect(controller.connectionSpy.isConnected(connectionId)).toBe(true)

      // Send multiple events from server
      await controller.testSendEvent(connectionId, {
        event: 'notification',
        data: { id: '1', message: 'First event' },
      })

      await controller.testSendEvent(connectionId, {
        event: 'notification',
        data: { id: '2', message: 'Second event' },
      })

      await controller.testSendEvent(connectionId, {
        event: 'notification',
        data: { id: '3', message: 'Third event' },
      })

      // Wait for collected events
      const events = await eventsPromise

      expect(events).toHaveLength(3)
      expect(JSON.parse(events[0]!.data)).toEqual({ id: '1', message: 'First event' })
      expect(JSON.parse(events[1]!.data)).toEqual({ id: '2', message: 'Second event' })
      expect(JSON.parse(events[2]!.data)).toEqual({ id: '3', message: 'Third event' })

      // Signal handler can complete, then close client connection
      controller.completeHandler(connectionId)
      clientConnection.close()
    },
  )

  it('handles interleaved events with delays', { timeout: 10000 }, async () => {
    const controller = getController()

    const clientConnection = await connectSSE(server.baseUrl, '/api/notifications/stream', {
      query: { userId: 'delayed-user' },
    })

    const eventsPromise = clientConnection.collectEvents(3)
    const serverConnection = await controller.connectionSpy.waitForConnection()

    // Send events with delays between them
    await controller.testSendEvent(serverConnection.id, {
      event: 'notification',
      data: { id: '1', message: 'Immediate' },
    })

    await new Promise((r) => setTimeout(r, 100))

    await controller.testSendEvent(serverConnection.id, {
      event: 'notification',
      data: { id: '2', message: 'After 100ms' },
    })

    await new Promise((r) => setTimeout(r, 200))

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
    clientConnection.close()
  })

  it('supports multiple concurrent connections', { timeout: 10000 }, async () => {
    const controller = getController()

    // Connect two clients
    const client1 = await connectSSE(server.baseUrl, '/api/notifications/stream', {
      query: { userId: 'user-1' },
    })
    const client2 = await connectSSE(server.baseUrl, '/api/notifications/stream', {
      query: { userId: 'user-2' },
    })

    const events1Promise = client1.collectEvents(1)
    const events2Promise = client2.collectEvents(1)

    // Wait for both connections
    const conn1 = await controller.connectionSpy.waitForConnection()

    // Need to wait a bit for the second connection to register
    await new Promise((r) => setTimeout(r, 50))

    // Get all connections and find the second one
    expect(controller.testGetConnectionCount()).toBe(2)
    const connections = controller.testGetConnections()
    const conn2 = connections.find((c) => c.id !== conn1.id)!
    expect(conn2).toBeDefined()

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
    const clients = await Promise.all([
      connectSSE(server.baseUrl, '/api/notifications/stream', { query: { userId: 'u1' } }),
      connectSSE(server.baseUrl, '/api/notifications/stream', { query: { userId: 'u2' } }),
      connectSSE(server.baseUrl, '/api/notifications/stream', { query: { userId: 'u3' } }),
    ])

    const eventsPromises = clients.map((c) => c.collectEvents(1))

    // Wait for all connections
    await new Promise((r) => setTimeout(r, 100))
    expect(controller.testGetConnectionCount()).toBe(3)

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
    for (const conn of controller.testGetConnections()) {
      controller.completeHandler(conn.id)
    }
    for (const client of clients) {
      client.close()
    }
  })

  it('handles broadcastIf with predicate', { timeout: 10000 }, async () => {
    const controller = getController()

    // Connect two clients with different contexts
    const vipClient = await connectSSE(server.baseUrl, '/api/notifications/stream', {
      query: { userId: 'vip-user' },
    })
    const regularClient = await connectSSE(server.baseUrl, '/api/notifications/stream', {
      query: { userId: 'regular-user' },
    })

    // Wait for connections and set up context
    await new Promise((r) => setTimeout(r, 100))

    const connections = controller.testGetConnections()
    // Set context to identify VIP connection
    const vipConn = connections.find(
      (c) => (c.context as { userId?: string })?.userId === 'vip-user',
    )!
    const regularConn = connections.find(
      (c) => (c.context as { userId?: string })?.userId === 'regular-user',
    )!

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

    const client1 = await connectSSE(server.baseUrl, '/api/notifications/stream', {
      query: { userId: 'u1' },
    })
    await controller.connectionSpy.waitForConnection()
    expect(controller.testGetConnectionCount()).toBe(1)

    const client2 = await connectSSE(server.baseUrl, '/api/notifications/stream', {
      query: { userId: 'u2' },
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(controller.testGetConnectionCount()).toBe(2)

    // Close one client
    const conn1 = controller.testGetConnections()[0]!
    controller.completeHandler(conn1.id)
    controller.testCloseConnection(conn1.id)
    client1.close()

    await new Promise((r) => setTimeout(r, 50))
    expect(controller.testGetConnectionCount()).toBe(1)

    // Close remaining
    const conn2 = controller.testGetConnections()[0]!
    controller.completeHandler(conn2.id)
    client2.close()
  })

  it('server can close connection', { timeout: 10000 }, async () => {
    const controller = getController()

    const client = await connectSSE(server.baseUrl, '/api/notifications/stream', {
      query: { userId: 'will-be-closed' },
    })

    const serverConn = await controller.connectionSpy.waitForConnection()

    // Send an event first
    await controller.testSendEvent(serverConn.id, {
      event: 'notification',
      data: { id: '1', message: 'Before close' },
    })

    // Server initiates close
    controller.completeHandler(serverConn.id)
    const closed = controller.testCloseConnection(serverConn.id)
    expect(closed).toBe(true)

    // Connection should be removed
    expect(controller.testGetConnectionCount()).toBe(0)

    client.close()
  })
})

describe('SSE E2E (OpenAI-style streaming)', () => {
  let server: SSETestServer<{ context: DIContext<object, object> }>
  let context: DIContext<object, object>

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestPostSSEModule()] }, undefined)

    server = await createSSETestServer(
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

  it('streams response chunks for POST request', { timeout: 10000 }, async () => {
    const { closed } = injectPayloadSSE(server.app, chatCompletionContract, {
      body: { message: 'Hello World', stream: true as const },
    })

    const response = await closed

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/event-stream')

    const events = parseSSEEvents(response.body)

    // Should have chunk events for each word plus a done event
    const chunkEvents = events.filter((e) => e.event === 'chunk')
    const doneEvents = events.filter((e) => e.event === 'done')

    expect(chunkEvents).toHaveLength(2) // "Hello" and "World"
    expect(doneEvents).toHaveLength(1)

    expect(JSON.parse(chunkEvents[0]!.data)).toEqual({ content: 'Hello' })
    expect(JSON.parse(chunkEvents[1]!.data)).toEqual({ content: 'World' })
    expect(JSON.parse(doneEvents[0]!.data)).toEqual({ totalTokens: 2 })
  })

  it('handles longer streaming responses', { timeout: 10000 }, async () => {
    const longMessage = 'The quick brown fox jumps over the lazy dog'
    const words = longMessage.split(' ')

    const { closed } = injectPayloadSSE(server.app, chatCompletionContract, {
      body: { message: longMessage, stream: true as const },
    })

    const response = await closed
    const events = parseSSEEvents(response.body)

    const chunkEvents = events.filter((e) => e.event === 'chunk')
    expect(chunkEvents).toHaveLength(words.length)

    // Verify all words streamed in order
    for (let i = 0; i < words.length; i++) {
      expect(JSON.parse(chunkEvents[i]!.data).content).toBe(words[i])
    }

    // Done event should have correct token count
    const doneEvent = events.find((e) => e.event === 'done')!
    expect(JSON.parse(doneEvent.data).totalTokens).toBe(words.length)
  })

  it('returns proper SSE headers for POST requests', { timeout: 10000 }, async () => {
    const { closed } = injectPayloadSSE(server.app, chatCompletionContract, {
      body: { message: 'test', stream: true as const },
    })

    const response = await closed

    expect(response.headers['content-type']).toContain('text/event-stream')
    expect(response.headers['cache-control']).toContain('no-cache')
  })
})

describe('SSE E2E (authentication)', () => {
  let server: SSETestServer<{ context: DIContext<object, object> }>
  let context: DIContext<object, object>

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestAuthSSEModule()] }, undefined)

    server = await createSSETestServer(
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

  it('rejects requests without authorization header', { timeout: 10000 }, async () => {
    const { closed } = injectSSE(server.app, authenticatedStreamContract, {
      headers: { authorization: '' },
    })

    const response = await closed

    expect(response.statusCode).toBe(401)
  })

  it('rejects requests with invalid authorization format', { timeout: 10000 }, async () => {
    const { closed } = injectSSE(server.app, authenticatedStreamContract, {
      headers: { authorization: 'Basic invalid' },
    })

    const response = await closed

    expect(response.statusCode).toBe(401)
  })

  it('accepts requests with valid Bearer token', { timeout: 10000 }, async () => {
    const { closed } = injectSSE(server.app, authenticatedStreamContract, {
      headers: { authorization: 'Bearer valid-token' },
    })

    const response = await closed

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/event-stream')

    const events = parseSSEEvents(response.body)
    expect(events).toHaveLength(1)
    expect(events[0]!.event).toBe('data')
    expect(JSON.parse(events[0]!.data)).toEqual({ value: 'authenticated data' })
  })

  it('works with real HTTP connection and auth headers', { timeout: 10000 }, async () => {
    // Test using connectSSE (real HTTP) instead of inject
    const client = await connectSSE(server.baseUrl, '/api/protected/stream', {
      headers: { Authorization: 'Bearer real-token' },
    })

    expect(client.response.ok).toBe(true)
    expect(client.response.headers.get('content-type')).toContain('text/event-stream')

    // The handler sends one event and then completes
    const events = await client.collectEvents(1)
    expect(events[0]!.event).toBe('data')
    expect(JSON.parse(events[0]!.data)).toEqual({ value: 'authenticated data' })

    client.close()
  })
})

describe('SSE E2E (path parameters)', () => {
  let server: SSETestServer<{ context: DIContext<object, object> }>
  let context: DIContext<object, object>

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<object, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestChannelSSEModule()] }, undefined)

    server = await createSSETestServer(
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

  it('handles path parameters correctly', { timeout: 10000 }, async () => {
    const { closed } = injectSSE(server.app, channelStreamContract, {
      params: { channelId: 'general' },
    })

    const response = await closed

    expect(response.statusCode).toBe(200)

    const events = parseSSEEvents(response.body)
    expect(events).toHaveLength(1)
    expect(events[0]!.event).toBe('message')
    expect(JSON.parse(events[0]!.data)).toEqual({
      id: '1',
      content: 'Welcome to channel general',
      author: 'system',
    })
  })

  it('handles different channel IDs', { timeout: 10000 }, async () => {
    const channelIds = ['channel-1', 'lobby', 'support-123']

    for (const channelId of channelIds) {
      const { closed } = injectSSE(server.app, channelStreamContract, {
        params: { channelId },
      })

      const response = await closed
      const events = parseSSEEvents(response.body)

      expect(JSON.parse(events[0]!.data).content).toBe(`Welcome to channel ${channelId}`)
    }
  })

  it('handles path params with query params together', { timeout: 10000 }, async () => {
    const { closed } = injectSSE(server.app, channelStreamContract, {
      params: { channelId: 'test-channel' },
      query: { since: '2024-01-01' },
    })

    const response = await closed

    expect(response.statusCode).toBe(200)

    const events = parseSSEEvents(response.body)
    expect(events).toHaveLength(1)
    expect(JSON.parse(events[0]!.data).content).toBe('Welcome to channel test-channel')
  })

  it('works with real HTTP connection and path params', { timeout: 10000 }, async () => {
    const client = await connectSSE(server.baseUrl, '/api/channels/my-channel/stream')

    expect(client.response.ok).toBe(true)

    const events = await client.collectEvents(1)
    expect(JSON.parse(events[0]!.data).content).toBe('Welcome to channel my-channel')

    client.close()
  })
})

describe('SSE E2E (error handling)', () => {
  let server: SSETestServer<{ context: DIContext<TestSSEModuleDependencies, object> }>
  let context: DIContext<TestSSEModuleDependencies, object>

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<TestSSEModuleDependencies, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestSSEModule()] }, undefined)

    server = await createSSETestServer(
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

    const client = await connectSSE(server.baseUrl, '/api/notifications/stream', {
      query: { userId: 'disconnect-test' },
    })

    const serverConn = await controller.connectionSpy.waitForConnection()

    // Client disconnects abruptly
    client.close()

    // Wait a bit for disconnect to propagate
    await new Promise((r) => setTimeout(r, 100))

    // Sending should now fail or handle gracefully
    const result = await controller.testSendEvent(serverConn.id, {
      event: 'notification',
      data: { id: '1', message: 'After disconnect' },
    })

    // Should return false since connection is dead
    expect(result).toBe(false)

    controller.completeHandler(serverConn.id)
  })
})

describe('SSE E2E (serialization)', () => {
  let server: SSETestServer<{ context: DIContext<TestSSEModuleDependencies, object> }>
  let context: DIContext<TestSSEModuleDependencies, object>

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<TestSSEModuleDependencies, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestSSEModule()] }, undefined)

    server = await createSSETestServer(
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

  it('serializes nested objects correctly', { timeout: 10000 }, async () => {
    const controller = getController()

    const client = await connectSSE(server.baseUrl, '/api/notifications/stream', {
      query: { userId: 'serialization-test' },
    })

    const eventsPromise = client.collectEvents(1)
    const serverConn = await controller.connectionSpy.waitForConnection()

    const complexData = {
      id: 'nested-1',
      message: 'Complex object',
      metadata: {
        nested: {
          deeply: {
            value: 42,
            array: [1, 2, 3],
          },
        },
        tags: ['a', 'b', 'c'],
      },
    }

    await controller.testSendEvent(serverConn.id, {
      event: 'notification',
      data: complexData,
    })

    const events = await eventsPromise
    const received = JSON.parse(events[0]!.data)

    expect(received).toEqual(complexData)

    controller.completeHandler(serverConn.id)
    client.close()
  })

  it('handles special characters in data', { timeout: 10000 }, async () => {
    const controller = getController()

    const client = await connectSSE(server.baseUrl, '/api/notifications/stream', {
      query: { userId: 'special-chars' },
    })

    const eventsPromise = client.collectEvents(1)
    const serverConn = await controller.connectionSpy.waitForConnection()

    const specialData = {
      id: 'special-1',
      message: 'Special: "quotes", \'apostrophes\', newlines\nand\ttabs, unicode: 日本語 🎉',
    }

    await controller.testSendEvent(serverConn.id, {
      event: 'notification',
      data: specialData,
    })

    const events = await eventsPromise
    const received = JSON.parse(events[0]!.data)

    expect(received).toEqual(specialData)

    controller.completeHandler(serverConn.id)
    client.close()
  })

  it('handles arrays at top level', { timeout: 10000 }, async () => {
    const controller = getController()

    const client = await connectSSE(server.baseUrl, '/api/notifications/stream', {
      query: { userId: 'array-test' },
    })

    const eventsPromise = client.collectEvents(1)
    const serverConn = await controller.connectionSpy.waitForConnection()

    // The contract expects { id, message }, but we can test array handling
    // by putting array data inside the expected structure
    const arrayData = {
      id: 'array-1',
      message: JSON.stringify([{ item: 1 }, { item: 2 }, { item: 3, nested: [4, 5, 6] }]),
    }

    await controller.testSendEvent(serverConn.id, {
      event: 'notification',
      data: arrayData,
    })

    const events = await eventsPromise
    const received = JSON.parse(events[0]!.data)

    expect(received).toEqual(arrayData)

    controller.completeHandler(serverConn.id)
    client.close()
  })

  it('handles null and undefined values', { timeout: 10000 }, async () => {
    const controller = getController()

    const client = await connectSSE(server.baseUrl, '/api/notifications/stream', {
      query: { userId: 'null-test' },
    })

    const eventsPromise = client.collectEvents(1)
    const serverConn = await controller.connectionSpy.waitForConnection()

    const nullData = {
      id: 'null-1',
      message: 'test',
      optionalField: null,
    }

    await controller.testSendEvent(serverConn.id, {
      event: 'notification',
      data: nullData,
    })

    const events = await eventsPromise
    const received = JSON.parse(events[0]!.data)

    expect(received).toEqual(nullData)

    controller.completeHandler(serverConn.id)
    client.close()
  })

  it('handles numeric values correctly', { timeout: 10000 }, async () => {
    const controller = getController()

    const client = await connectSSE(server.baseUrl, '/api/notifications/stream', {
      query: { userId: 'numeric-test' },
    })

    const eventsPromise = client.collectEvents(1)
    const serverConn = await controller.connectionSpy.waitForConnection()

    const numericData = {
      id: 'numeric-1',
      message: 'Numbers test',
      integer: 42,
      float: Math.PI,
      negative: -100,
      scientific: 1.5e10,
    }

    await controller.testSendEvent(serverConn.id, {
      event: 'notification',
      data: numericData,
    })

    const events = await eventsPromise
    const received = JSON.parse(events[0]!.data)

    expect(received).toEqual(numericData)

    controller.completeHandler(serverConn.id)
    client.close()
  })

  it('handles boolean values correctly', { timeout: 10000 }, async () => {
    const controller = getController()

    const client = await connectSSE(server.baseUrl, '/api/notifications/stream', {
      query: { userId: 'boolean-test' },
    })

    const eventsPromise = client.collectEvents(1)
    const serverConn = await controller.connectionSpy.waitForConnection()

    const booleanData = {
      id: 'boolean-1',
      message: 'Boolean test',
      isActive: true,
      isDeleted: false,
    }

    await controller.testSendEvent(serverConn.id, {
      event: 'notification',
      data: booleanData,
    })

    const events = await eventsPromise
    const received = JSON.parse(events[0]!.data)

    expect(received).toEqual(booleanData)

    controller.completeHandler(serverConn.id)
    client.close()
  })
})

describe('SSE E2E (event metadata)', () => {
  let server: SSETestServer<{ context: DIContext<TestSSEModuleDependencies, object> }>
  let context: DIContext<TestSSEModuleDependencies, object>

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<TestSSEModuleDependencies, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestSSEModule()] }, undefined)

    server = await createSSETestServer(
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

    const client = await connectSSE(server.baseUrl, '/api/notifications/stream', {
      query: { userId: 'event-id-test' },
    })

    const eventsPromise = client.collectEvents(1)
    const serverConn = await controller.connectionSpy.waitForConnection()

    await controller.testSendEvent(serverConn.id, {
      event: 'notification',
      data: { id: '1', message: 'With custom ID' },
      id: 'custom-event-id-123',
    })

    const events = await eventsPromise
    expect(events[0]!.id).toBe('custom-event-id-123')

    controller.completeHandler(serverConn.id)
    client.close()
  })

  it('sends events with different event types', { timeout: 10000 }, async () => {
    const controller = getController()

    const client = await connectSSE(server.baseUrl, '/api/notifications/stream', {
      query: { userId: 'event-types-test' },
    })

    const eventsPromise = client.collectEvents(3)
    const serverConn = await controller.connectionSpy.waitForConnection()

    // Send events with different event types
    await controller.testSendEvent(serverConn.id, {
      event: 'notification',
      data: { id: '1', message: 'Notification' },
    })

    await controller.testSendEvent(serverConn.id, {
      event: 'alert',
      data: { id: '2', message: 'Alert' },
    })

    await controller.testSendEvent(serverConn.id, {
      event: 'system',
      data: { id: '3', message: 'System' },
    })

    const events = await eventsPromise
    expect(events[0]!.event).toBe('notification')
    expect(events[1]!.event).toBe('alert')
    expect(events[2]!.event).toBe('system')

    controller.completeHandler(serverConn.id)
    client.close()
  })

  it('sends event without explicit event type (uses message)', { timeout: 10000 }, async () => {
    const controller = getController()

    const client = await connectSSE(server.baseUrl, '/api/notifications/stream', {
      query: { userId: 'no-event-type' },
    })

    const eventsPromise = client.collectEvents(1)
    const serverConn = await controller.connectionSpy.waitForConnection()

    // Send without event type
    await controller.testSendEvent(serverConn.id, {
      data: { id: '1', message: 'No event type' },
    })

    const events = await eventsPromise
    // Event type should be undefined when not specified
    expect(events[0]!.event).toBeUndefined()
    expect(JSON.parse(events[0]!.data).message).toBe('No event type')

    controller.completeHandler(serverConn.id)
    client.close()
  })
})

describe('SSE E2E (connection lifecycle)', () => {
  let server: SSETestServer<{ context: DIContext<TestSSEModuleDependencies, object> }>
  let context: DIContext<TestSSEModuleDependencies, object>

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<TestSSEModuleDependencies, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestSSEModule()] }, undefined)

    server = await createSSETestServer(
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

  it('tracks connection events in spy', { timeout: 10000 }, async () => {
    const controller = getController()

    const client = await connectSSE(server.baseUrl, '/api/notifications/stream', {
      query: { userId: 'lifecycle-test' },
    })

    const serverConn = await controller.connectionSpy.waitForConnection()

    // Check connection event was recorded
    const events = controller.connectionSpy.getEvents()
    const connectEvent = events.find(
      (e) => e.type === 'connect' && e.connectionId === serverConn.id,
    )
    expect(connectEvent).toBeDefined()
    expect(connectEvent!.connection).toBeDefined()

    controller.completeHandler(serverConn.id)
    controller.testCloseConnection(serverConn.id)
    client.close()

    await controller.connectionSpy.waitForDisconnection(serverConn.id)

    const allEvents = controller.connectionSpy.getEvents()
    const disconnectEvent = allEvents.find(
      (e) => e.type === 'disconnect' && e.connectionId === serverConn.id,
    )
    expect(disconnectEvent).toBeDefined()
  })

  it('isConnected returns correct status', { timeout: 10000 }, async () => {
    const controller = getController()

    const client = await connectSSE(server.baseUrl, '/api/notifications/stream', {
      query: { userId: 'connected-test' },
    })

    const serverConn = await controller.connectionSpy.waitForConnection()

    expect(controller.connectionSpy.isConnected(serverConn.id)).toBe(true)

    controller.completeHandler(serverConn.id)
    controller.testCloseConnection(serverConn.id)
    client.close()

    await controller.connectionSpy.waitForDisconnection(serverConn.id)

    expect(controller.connectionSpy.isConnected(serverConn.id)).toBe(false)
  })

  it('connection context is preserved', { timeout: 10000 }, async () => {
    const controller = getController()

    const client = await connectSSE(server.baseUrl, '/api/notifications/stream', {
      query: { userId: 'context-user-123' },
    })

    const serverConn = await controller.connectionSpy.waitForConnection()

    // The handler sets context.userId from query param
    expect(serverConn.context).toBeDefined()
    expect((serverConn.context as { userId?: string }).userId).toBe('context-user-123')

    controller.completeHandler(serverConn.id)
    client.close()
  })

  it('connection has metadata', { timeout: 10000 }, async () => {
    const controller = getController()

    const client = await connectSSE(server.baseUrl, '/api/notifications/stream', {
      query: { userId: 'metadata-test' },
    })

    const serverConn = await controller.connectionSpy.waitForConnection()

    expect(serverConn.id).toBeDefined()
    expect(typeof serverConn.id).toBe('string')
    expect(serverConn.connectedAt).toBeInstanceOf(Date)
    expect(serverConn.request).toBeDefined()
    expect(serverConn.reply).toBeDefined()

    controller.completeHandler(serverConn.id)
    client.close()
  })
})

/**
 * Tests for SSE Last-Event-ID reconnection mechanism.
 *
 * How SSE reconnection works:
 * 1. Client connects and receives events, each with an `id` field
 * 2. Client disconnects (network error, server restart, etc.)
 * 3. Browser automatically reconnects and sends `Last-Event-ID` header with the last received event ID
 * 4. Server's `onReconnect` handler receives this ID and replays missed events
 *
 * These tests simulate step 3 by sending the `Last-Event-ID` header directly.
 * The server doesn't track previous sessions - it just responds to the header.
 */
describe('SSE E2E (Last-Event-ID reconnection)', () => {
  let server: SSETestServer<{ context: DIContext<TestReconnectSSEModuleDependencies, object> }>
  let context: DIContext<TestReconnectSSEModuleDependencies, object>

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<TestReconnectSSEModuleDependencies, object>(
      container,
      { isTestMode: true },
      {},
    )
    context.registerDependencies({ modules: [new TestReconnectSSEModule()] }, undefined)

    server = await createSSETestServer(
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

  it('replays events after Last-Event-ID on reconnection', { timeout: 10000 }, async () => {
    // Use injectSSE with Last-Event-ID header to simulate reconnection
    const { closed } = injectSSE(server.app, reconnectStreamContract, {
      headers: { 'last-event-id': '2' } as Record<string, string>,
    })

    const response = await closed

    expect(response.statusCode).toBe(200)

    const events = parseSSEEvents(response.body)
    // Should replay events 3, 4, 5 (after id 2) plus the new event 6
    const eventDatas = events.map((e) => JSON.parse(e.data))

    // Events 3, 4, 5 are replayed, then 6 is sent by the handler
    expect(eventDatas).toContainEqual({ id: '3', data: 'Third event' })
    expect(eventDatas).toContainEqual({ id: '4', data: 'Fourth event' })
    expect(eventDatas).toContainEqual({ id: '5', data: 'Fifth event' })
    expect(eventDatas).toContainEqual({ id: '6', data: 'New event after reconnect' })
  })

  it('sends only new events when reconnecting with latest ID', { timeout: 10000 }, async () => {
    const { closed } = injectSSE(server.app, reconnectStreamContract, {
      headers: { 'last-event-id': '5' } as Record<string, string>,
    })

    const response = await closed

    expect(response.statusCode).toBe(200)

    const events = parseSSEEvents(response.body)
    // No events to replay after id 5, just the new event 6
    expect(events).toHaveLength(1)
    expect(JSON.parse(events[0]!.data)).toEqual({ id: '6', data: 'New event after reconnect' })
  })

  it('connects without replay when no Last-Event-ID', { timeout: 10000 }, async () => {
    const { closed } = injectSSE(server.app, reconnectStreamContract, {})

    const response = await closed

    expect(response.statusCode).toBe(200)

    const events = parseSSEEvents(response.body)
    // Just the new event, no replay
    expect(events).toHaveLength(1)
    expect(JSON.parse(events[0]!.data)).toEqual({ id: '6', data: 'New event after reconnect' })
  })

  it('replays events using async iterable', { timeout: 10000 }, async () => {
    const { closed } = injectSSE(server.app, asyncReconnectStreamContract, {
      headers: { 'last-event-id': '1' },
    })

    const response = await closed

    expect(response.statusCode).toBe(200)

    const events = parseSSEEvents(response.body)
    const eventDatas = events.map((e) => JSON.parse(e.data))

    // Events 2, 3 are replayed via async generator, then 4 is sent by handler
    expect(eventDatas).toContainEqual({ id: '2', data: 'Async second event' })
    expect(eventDatas).toContainEqual({ id: '3', data: 'Async third event' })
    expect(eventDatas).toContainEqual({ id: '4', data: 'Async new event after reconnect' })
  })

  it('async replay works with no events to replay', { timeout: 10000 }, async () => {
    const { closed } = injectSSE(server.app, asyncReconnectStreamContract, {
      headers: { 'last-event-id': '3' },
    })

    const response = await closed

    expect(response.statusCode).toBe(200)

    const events = parseSSEEvents(response.body)
    // No events to replay after id 3, just the new event 4
    expect(events).toHaveLength(1)
    expect(JSON.parse(events[0]!.data)).toEqual({
      id: '4',
      data: 'Async new event after reconnect',
    })
  })
})

describe('SSE E2E (SSEConnectionSpy edge cases)', () => {
  let server: SSETestServer<{ context: DIContext<TestSSEModuleDependencies, object> }>
  let context: DIContext<TestSSEModuleDependencies, object>

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    context = new DIContext<TestSSEModuleDependencies, object>(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new TestSSEModule()] }, undefined)

    server = await createSSETestServer(
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

    const client = await connectSSE(server.baseUrl, '/api/notifications/stream', {
      query: { userId: 'timeout-test' },
    })

    const serverConn = await controller.connectionSpy.waitForConnection()

    // Wait for disconnection but don't close the connection - should timeout
    await expect(
      controller.connectionSpy.waitForDisconnection(serverConn.id, { timeout: 100 }),
    ).rejects.toThrow('Timeout waiting for disconnection after 100ms')

    // Clean up
    controller.completeHandler(serverConn.id)
    client.close()
  })

  it('clear() cancels pending waiters and resets state', { timeout: 10000 }, async () => {
    const controller = getController()

    // Start waiting for connection (will never arrive)
    const waitPromise = controller.connectionSpy.waitForConnection({ timeout: 5000 })

    // Give the waiter time to register
    await new Promise((r) => setTimeout(r, 50))

    // Clear the spy - should reject the pending waiter
    controller.connectionSpy.clear()

    await expect(waitPromise).rejects.toThrow('ConnectionSpy was cleared')

    // Events should be empty after clear
    expect(controller.connectionSpy.getEvents()).toHaveLength(0)
  })

  it('clear() cancels pending disconnection waiters', { timeout: 10000 }, async () => {
    const controller = getController()

    const client = await connectSSE(server.baseUrl, '/api/notifications/stream', {
      query: { userId: 'clear-test' },
    })

    const serverConn = await controller.connectionSpy.waitForConnection()

    // Start waiting for disconnection
    const waitPromise = controller.connectionSpy.waitForDisconnection(serverConn.id, {
      timeout: 5000,
    })

    // Give the waiter time to register
    await new Promise((r) => setTimeout(r, 50))

    // Clear the spy
    controller.connectionSpy.clear()

    await expect(waitPromise).rejects.toThrow('ConnectionSpy was cleared')

    controller.completeHandler(serverConn.id)
    client.close()
  })

  it(
    'waitForDisconnection resolves immediately if already disconnected',
    { timeout: 10000 },
    async () => {
      const controller = getController()

      const client = await connectSSE(server.baseUrl, '/api/notifications/stream', {
        query: { userId: 'already-disconnected' },
      })

      const serverConn = await controller.connectionSpy.waitForConnection()

      // Close the connection first
      controller.completeHandler(serverConn.id)
      controller.testCloseConnection(serverConn.id)
      client.close()

      // Wait for the disconnect to be processed
      await new Promise((r) => setTimeout(r, 100))

      // Now wait for disconnection - should resolve immediately since already disconnected
      await controller.connectionSpy.waitForDisconnection(serverConn.id, { timeout: 100 })
      // If we get here without timeout, the test passes
    },
  )

  it(
    'waitForConnection resolves immediately if connection already exists',
    { timeout: 10000 },
    async () => {
      const controller = getController()

      const client = await connectSSE(server.baseUrl, '/api/notifications/stream', {
        query: { userId: 'already-connected' },
      })

      // Wait for the connection to be established
      await new Promise((r) => setTimeout(r, 100))

      // Now waitForConnection should resolve immediately since connection exists
      const connection = await controller.connectionSpy.waitForConnection({ timeout: 100 })
      expect(connection).toBeDefined()
      expect(connection.id).toBeDefined()

      controller.completeHandler(connection.id)
      client.close()
    },
  )
})

describe('SSE E2E (controller without spy)', () => {
  it('throws error when accessing connectionSpy without enableConnectionSpy', async () => {
    // Create a controller without spy enabled (isTestMode: false)
    const container = createContainer({ injectionMode: 'PROXY' })
    const context = new DIContext<TestSSEModuleDependencies, object>(
      container,
      { isTestMode: false }, // Spy not enabled
      {},
    )
    context.registerDependencies({ modules: [new TestSSEModule()] }, undefined)

    const controller = context.diContainer.cradle.testSSEController

    expect(() => controller.connectionSpy).toThrow(
      'Connection spy is not enabled. Pass { enableConnectionSpy: true } to the constructor.',
    )

    await context.destroy()
  })
})
