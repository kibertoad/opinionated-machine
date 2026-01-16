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

  describe('events() with AbortSignal', () => {
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

    it('stops generator when AbortSignal fires', async () => {
      const controller = getController()

      const { client, serverConnection } = await SSEHttpClient.connect(
        server.baseUrl,
        '/api/notifications/stream',
        {
          query: { userId: 'abort-signal-test' },
          awaitServerConnection: { controller },
        },
      )

      const abortController = new AbortController()
      const collected: string[] = []

      // Start consuming events with abort signal
      const consumePromise = (async () => {
        for await (const event of client.events(abortController.signal)) {
          collected.push(event.event ?? 'message')
          if (collected.length === 2) {
            // Abort after receiving 2 events
            abortController.abort()
          }
        }
      })()

      // Send 5 events
      for (let i = 1; i <= 5; i++) {
        await controller.testSendEvent(serverConnection.id, {
          event: `event-${i}`,
          data: { id: String(i) },
        })
        await delay(10) // Small delay between events
      }

      await consumePromise

      // Should have stopped after 2 events due to abort
      expect(collected).toHaveLength(2)
      expect(collected).toEqual(['event-1', 'event-2'])

      controller.completeHandler(serverConnection.id)
      client.close()
    })

    it('handles already-aborted signal', async () => {
      const controller = getController()

      const { client, serverConnection } = await SSEHttpClient.connect(
        server.baseUrl,
        '/api/notifications/stream',
        {
          query: { userId: 'pre-aborted-test' },
          awaitServerConnection: { controller },
        },
      )

      // Create an already-aborted signal
      const abortController = new AbortController()
      abortController.abort()

      const collected: string[] = []
      for await (const event of client.events(abortController.signal)) {
        collected.push(event.event ?? 'message')
      }

      // Should exit immediately without collecting any events
      expect(collected).toHaveLength(0)

      controller.completeHandler(serverConnection.id)
      client.close()
    })
  })

  describe('resource cleanup', () => {
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

    it('close() after collectEvents timeout does not cause unhandled rejection', async () => {
      const controller = getController()

      const { client, serverConnection } = await SSEHttpClient.connect(
        server.baseUrl,
        '/api/notifications/stream',
        {
          query: { userId: 'cleanup-timeout-test' },
          awaitServerConnection: { controller },
        },
      )

      // Timeout while waiting for events (read is pending)
      await expect(client.collectEvents(1, 50)).rejects.toThrow('Timeout collecting events')

      // This should not cause unhandled rejection
      controller.completeHandler(serverConnection.id)
      client.close()

      // Give time for any potential unhandled rejections to surface
      await delay(50)
    })

    it('close() after early break from collectEvents does not cause unhandled rejection', async () => {
      const controller = getController()

      const { client, serverConnection } = await SSEHttpClient.connect(
        server.baseUrl,
        '/api/notifications/stream',
        {
          query: { userId: 'cleanup-break-test' },
          awaitServerConnection: { controller },
        },
      )

      // Start collecting, will break early when count is reached
      const eventsPromise = client.collectEvents(2, 5000)

      // Send 5 events but we only want 2
      for (let i = 1; i <= 5; i++) {
        await controller.testSendEvent(serverConnection.id, {
          event: `event-${i}`,
          data: { id: String(i) },
        })
      }

      const events = await eventsPromise
      expect(events).toHaveLength(2)

      // This should not cause unhandled rejection
      controller.completeHandler(serverConnection.id)
      client.close()

      // Give time for any potential unhandled rejections to surface
      await delay(50)
    })

    it('multiple sequential collectEvents calls work correctly', async () => {
      const controller = getController()

      const { client, serverConnection } = await SSEHttpClient.connect(
        server.baseUrl,
        '/api/notifications/stream',
        {
          query: { userId: 'sequential-collect-test' },
          awaitServerConnection: { controller },
        },
      )

      // First collect
      const firstPromise = client.collectEvents(2, 5000)
      await controller.testSendEvent(serverConnection.id, { event: 'a', data: { v: 1 } })
      await controller.testSendEvent(serverConnection.id, { event: 'b', data: { v: 2 } })
      const firstEvents = await firstPromise
      expect(firstEvents).toHaveLength(2)

      // Second collect (reusing same client)
      const secondPromise = client.collectEvents(2, 5000)
      await controller.testSendEvent(serverConnection.id, { event: 'c', data: { v: 3 } })
      await controller.testSendEvent(serverConnection.id, { event: 'd', data: { v: 4 } })
      const secondEvents = await secondPromise
      expect(secondEvents).toHaveLength(2)

      expect(firstEvents.map((e) => e.event)).toEqual(['a', 'b'])
      expect(secondEvents.map((e) => e.event)).toEqual(['c', 'd'])

      controller.completeHandler(serverConnection.id)
      client.close()
    })
  })
})
