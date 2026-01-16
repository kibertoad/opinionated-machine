import { createContainer } from 'awilix'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DIContext, SSEInjectClient, SSETestServer } from '../../index.js'
import { chatCompletionContract } from './fixtures/testContracts.js'
import {
  TestAuthSSEModule,
  TestChannelSSEModule,
  TestPostSSEModule,
} from './fixtures/testModules.js'

/**
 * E2E tests for SSEInjectClient with @fastify/sse.
 *
 * These tests validate that SSEInjectClient works correctly with the
 * AbstractSSEController pattern and @fastify/sse plugin.
 *
 * SSEInjectClient is designed for testing "request-response" style SSE streams
 * where the handler sends events and then closes the connection (like OpenAI completions).
 *
 * Note: SSEInjectClient uses Fastify's inject() which doesn't require a running server,
 * but we use SSETestServer to get a properly configured Fastify app with @fastify/sse.
 */
describe('SSEInjectClient E2E', () => {
  describe('POST requests (OpenAI-style streaming)', () => {
    let server: SSETestServer<{ context: DIContext<object, object> }>
    let client: SSEInjectClient

    beforeEach(async () => {
      const container = createContainer({ injectionMode: 'PROXY' })
      const context = new DIContext<object, object>(container, { isTestMode: true }, {})
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

      // SSEInjectClient works with the app directly - no server needed
      client = new SSEInjectClient(server.app)
    })

    afterEach(async () => {
      await server.resources.context.destroy()
      await server.close()
    })

    it('streams response chunks for POST request', async () => {
      const conn = await client.connectWithBody(chatCompletionContract.path, {
        message: 'Hello World Test',
        stream: true as const,
      })

      expect(conn.getStatusCode()).toBe(200)
      expect(conn.getHeaders()['content-type']).toContain('text/event-stream')

      const events = conn.getReceivedEvents()
      expect(events.length).toBeGreaterThan(0)

      // Should have chunk events for each word + done event
      const chunks = events.filter((e) => e.event === 'chunk')
      expect(chunks).toHaveLength(3) // "Hello", "World", "Test"

      const doneEvent = events.find((e) => e.event === 'done')
      expect(doneEvent).toBeDefined()
      expect(JSON.parse(doneEvent!.data).totalTokens).toBe(3)
    })

    it('parses streamed content correctly', async () => {
      const conn = await client.connectWithBody(chatCompletionContract.path, {
        message: 'One Two',
        stream: true as const,
      })

      const events = conn.getReceivedEvents()
      const chunks = events
        .filter((e) => e.event === 'chunk')
        .map((e) => JSON.parse(e.data).content)

      expect(chunks).toEqual(['One', 'Two'])
    })

    it('waitForEvent finds specific event type', async () => {
      const conn = await client.connectWithBody(chatCompletionContract.path, {
        message: 'Test',
        stream: true as const,
      })

      const doneEvent = await conn.waitForEvent('done')
      expect(JSON.parse(doneEvent.data).totalTokens).toBe(1)
    })

    it('waitForEvents returns requested count', async () => {
      const conn = await client.connectWithBody(chatCompletionContract.path, {
        message: 'A B C D',
        stream: true as const,
      })

      const events = await conn.waitForEvents(3)
      expect(events).toHaveLength(3)
    })
  })

  describe('GET requests with authentication', () => {
    let server: SSETestServer<{ context: DIContext<object, object> }>
    let client: SSEInjectClient

    beforeEach(async () => {
      const container = createContainer({ injectionMode: 'PROXY' })
      const context = new DIContext<object, object>(container, { isTestMode: true }, {})
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

      client = new SSEInjectClient(server.app)
    })

    afterEach(async () => {
      await server.resources.context.destroy()
      await server.close()
    })

    it('passes authorization header', async () => {
      const conn = await client.connect('/api/protected/stream', {
        headers: { authorization: 'Bearer valid-token' },
      })

      expect(conn.getStatusCode()).toBe(200)

      const events = conn.getReceivedEvents()
      expect(events).toHaveLength(1)
      expect(events[0]!.event).toBe('data')
      expect(JSON.parse(events[0]!.data).value).toBe('authenticated data')
    })

    it('returns error without authorization', async () => {
      const conn = await client.connect('/api/protected/stream')

      // Contract requires authorization header, so validation fails with 400
      expect(conn.getStatusCode()).toBe(400)
      expect(conn.getReceivedEvents()).toHaveLength(0)
    })
  })

  describe('GET requests with path params', () => {
    let server: SSETestServer<{ context: DIContext<object, object> }>
    let client: SSEInjectClient

    beforeEach(async () => {
      const container = createContainer({ injectionMode: 'PROXY' })
      const context = new DIContext<object, object>(container, { isTestMode: true }, {})
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

      client = new SSEInjectClient(server.app)
    })

    afterEach(async () => {
      await server.resources.context.destroy()
      await server.close()
    })

    it('handles path parameters', async () => {
      const conn = await client.connect('/api/channels/my-channel/stream')

      expect(conn.getStatusCode()).toBe(200)

      const events = conn.getReceivedEvents()
      expect(events).toHaveLength(1)
      expect(events[0]!.event).toBe('message')

      const data = JSON.parse(events[0]!.data)
      expect(data.content).toContain('my-channel')
    })
  })

  describe('connection state', () => {
    let server: SSETestServer<{ context: DIContext<object, object> }>
    let client: SSEInjectClient

    beforeEach(async () => {
      const container = createContainer({ injectionMode: 'PROXY' })
      const context = new DIContext<object, object>(container, { isTestMode: true }, {})
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

      client = new SSEInjectClient(server.app)
    })

    afterEach(async () => {
      await server.resources.context.destroy()
      await server.close()
    })

    it('isClosed returns true (inject responses are always complete)', async () => {
      const conn = await client.connectWithBody(chatCompletionContract.path, {
        message: 'Test',
        stream: true as const,
      })

      expect(conn.isClosed()).toBe(true)
    })

    it('close is a no-op for inject connections', async () => {
      const conn = await client.connectWithBody(chatCompletionContract.path, {
        message: 'Test',
        stream: true as const,
      })

      // Should not throw
      conn.close()
      expect(conn.isClosed()).toBe(true)
    })

    it('getReceivedEvents returns a copy', async () => {
      const conn = await client.connectWithBody(chatCompletionContract.path, {
        message: 'Test',
        stream: true as const,
      })

      const events1 = conn.getReceivedEvents()
      const events2 = conn.getReceivedEvents()

      expect(events1).not.toBe(events2)
      expect(events1).toEqual(events2)
    })
  })
})
