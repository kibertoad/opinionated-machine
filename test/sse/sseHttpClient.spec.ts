import { setTimeout as delay } from 'node:timers/promises'
import { createContainer } from 'awilix'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DIContext, SSEHttpClient, SSETestServer } from '../../index.js'
import type { TestSSEController } from './fixtures/testControllers.js'
import { TestSSEModule, type TestSSEModuleDependencies } from './fixtures/testModules.js'

/**
 * Tests for SSEHttpClient edge cases and error handling.
 */
describe('SSEHttpClient', () => {
  describe('collectEvents timeout handling', () => {
    let server: SSETestServer<{ context: DIContext<TestSSEModuleDependencies, object> }>
    let context: DIContext<TestSSEModuleDependencies, object>

    beforeEach(async () => {
      const container = createContainer({ injectionMode: 'PROXY' })
      context = new DIContext<TestSSEModuleDependencies, object>(
        container,
        { isTestMode: true },
        {},
      )
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
      'throws timeout error when no events arrive within timeout (Promise.race timeout)',
      { timeout: 10000 },
      async () => {
        const controller = getController()

        // Connect but don't send any events
        const { client, serverConnection } = await SSEHttpClient.connect(
          server.baseUrl,
          '/api/notifications/stream',
          {
            query: { userId: 'timeout-test' },
            awaitServerConnection: { controller },
          },
        )

        // Try to collect events with a very short timeout - no events will be sent
        await expect(client.collectEvents(1, 100)).rejects.toThrow(
          'Timeout collecting events (got 0)',
        )

        controller.completeHandler(serverConnection.id)
        client.close()
      },
    )

    it('collects events until predicate returns true', { timeout: 10000 }, async () => {
      const controller = getController()

      const { client, serverConnection } = await SSEHttpClient.connect(
        server.baseUrl,
        '/api/notifications/stream',
        {
          query: { userId: 'predicate-test' },
          awaitServerConnection: { controller },
        },
      )

      const eventsPromise = client.collectEvents((event) => event.event === 'done', 5000)

      // Send several events, with 'done' as the last one
      await controller.testSendEvent(serverConnection.id, {
        event: 'notification',
        data: { id: '1', message: 'First' },
      })
      await controller.testSendEvent(serverConnection.id, {
        event: 'notification',
        data: { id: '2', message: 'Second' },
      })
      await controller.testSendEvent(serverConnection.id, {
        event: 'done',
        data: { id: '3', message: 'Done' },
      })

      const events = await eventsPromise

      // Should have collected all 3 events (predicate match IS included)
      expect(events).toHaveLength(3)
      expect(events[2]!.event).toBe('done')

      controller.completeHandler(serverConnection.id)
      client.close()
    })
  })

  describe('collectEvents with immediate timeout', () => {
    let server: SSETestServer<{ context: DIContext<TestSSEModuleDependencies, object> }>
    let context: DIContext<TestSSEModuleDependencies, object>

    beforeEach(async () => {
      const container = createContainer({ injectionMode: 'PROXY' })
      context = new DIContext<TestSSEModuleDependencies, object>(
        container,
        { isTestMode: true },
        {},
      )
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
      'throws timeout error immediately when timeout is 0 or negative (line 269)',
      { timeout: 10000 },
      async () => {
        const controller = getController()

        const { client, serverConnection } = await SSEHttpClient.connect(
          server.baseUrl,
          '/api/notifications/stream',
          {
            query: { userId: 'zero-timeout-test' },
            awaitServerConnection: { controller },
          },
        )

        // Use timeout of 1ms - by the time we enter the loop, remainingTime will be <= 0
        // We need to add a small delay to ensure we hit the initial timeout check
        await delay(10)

        await expect(client.collectEvents(1, 1)).rejects.toThrow(
          'Timeout collecting events (got 0)',
        )

        controller.completeHandler(serverConnection.id)
        client.close()
      },
    )

    it(
      'throws timeout error when timeout expires before loop iteration (line 269 edge case)',
      { timeout: 10000 },
      async () => {
        const controller = getController()

        const { client, serverConnection } = await SSEHttpClient.connect(
          server.baseUrl,
          '/api/notifications/stream',
          {
            query: { userId: 'expired-timeout-test' },
            awaitServerConnection: { controller },
          },
        )

        // Use setTimeout to ensure time passes, then call with timeout=0
        // This guarantees remainingTime <= 0 on the first check (line 268-269)
        await delay(50)

        await expect(client.collectEvents(1, 0)).rejects.toThrow(
          'Timeout collecting events (got 0)',
        )

        controller.completeHandler(serverConnection.id)
        client.close()
      },
    )
  })
})
