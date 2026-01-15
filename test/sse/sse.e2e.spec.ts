import { createContainer } from 'awilix'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { connectSSE, createSSETestServer, DIContext, type SSETestServer } from '../../index.js'
import type { TestSSEController } from './fixtures/testControllers.js'
import { TestSSEModule, type TestSSEModuleDependencies } from './fixtures/testModules.js'

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
})
