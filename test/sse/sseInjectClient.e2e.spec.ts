import { createContainer } from 'awilix'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest'
import { DIContext, SSEInjectClient } from '../../index.js'
import { createSSETestServer, type SSETestServerWithResources } from '../sseTestServerFactory.js'
import { bodyForStatusGetContract, chatCompletionContract } from './fixtures/testContracts.js'
import {
  TestAuthSSEModule,
  TestBodyForStatusModule,
  type TestBodyForStatusModuleDependencies,
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
 * but we use createSSETestServer to get a properly configured Fastify app with @fastify/sse.
 */
describe('SSEInjectClient E2E', () => {
  describe('POST requests (OpenAI-style streaming)', () => {
    let server: SSETestServerWithResources<{ context: DIContext<object, object> }>
    let client: SSEInjectClient

    beforeEach(async () => {
      const container = createContainer({ injectionMode: 'PROXY' })
      const context = new DIContext<object, object>(container, { isTestMode: true }, {})
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

      // SSEInjectClient works with the app directly - no server needed
      client = new SSEInjectClient(server.app)
    })

    afterEach(async () => {
      await server.resources.context.destroy()
      await server.close()
    })

    it('streams response chunks for POST request', async () => {
      const conn = await client.connectWithBody(chatCompletionContract.pathResolver({}), {
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
      const conn = await client.connectWithBody(chatCompletionContract.pathResolver({}), {
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
      const conn = await client.connectWithBody(chatCompletionContract.pathResolver({}), {
        message: 'Test',
        stream: true as const,
      })

      const doneEvent = await conn.waitForEvent('done')
      expect(JSON.parse(doneEvent.data).totalTokens).toBe(1)
    })

    it('waitForEvents returns requested count', async () => {
      const conn = await client.connectWithBody(chatCompletionContract.pathResolver({}), {
        message: 'A B C D',
        stream: true as const,
      })

      const events = await conn.waitForEvents(3)
      expect(events).toHaveLength(3)
    })
  })

  describe('GET requests with authentication', () => {
    let server: SSETestServerWithResources<{ context: DIContext<object, object> }>
    let client: SSEInjectClient

    beforeEach(async () => {
      const container = createContainer({ injectionMode: 'PROXY' })
      const context = new DIContext<object, object>(container, { isTestMode: true }, {})
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
    let server: SSETestServerWithResources<{ context: DIContext<object, object> }>
    let client: SSEInjectClient

    beforeEach(async () => {
      const container = createContainer({ injectionMode: 'PROXY' })
      const context = new DIContext<object, object>(container, { isTestMode: true }, {})
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
    let server: SSETestServerWithResources<{ context: DIContext<object, object> }>
    let client: SSEInjectClient

    beforeEach(async () => {
      const container = createContainer({ injectionMode: 'PROXY' })
      const context = new DIContext<object, object>(container, { isTestMode: true }, {})
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

      client = new SSEInjectClient(server.app)
    })

    afterEach(async () => {
      await server.resources.context.destroy()
      await server.close()
    })

    it('isClosed returns true (inject responses are always complete)', async () => {
      const conn = await client.connectWithBody(chatCompletionContract.pathResolver({}), {
        message: 'Test',
        stream: true as const,
      })

      expect(conn.isClosed()).toBe(true)
    })

    it('close is a no-op for inject connections', async () => {
      const conn = await client.connectWithBody(chatCompletionContract.pathResolver({}), {
        message: 'Test',
        stream: true as const,
      })

      // Should not throw
      conn.close()
      expect(conn.isClosed()).toBe(true)
    })

    it('getReceivedEvents returns a copy', async () => {
      const conn = await client.connectWithBody(chatCompletionContract.pathResolver({}), {
        message: 'Test',
        stream: true as const,
      })

      const events1 = conn.getReceivedEvents()
      const events2 = conn.getReceivedEvents()

      expect(events1).not.toBe(events2)
      expect(events1).toEqual(events2)
    })
  })

  describe('response body access', () => {
    let server: SSETestServerWithResources<{
      context: DIContext<TestBodyForStatusModuleDependencies, object>
    }>
    let client: SSEInjectClient

    beforeEach(async () => {
      const container = createContainer<TestBodyForStatusModuleDependencies>({
        injectionMode: 'PROXY',
      })
      const context = new DIContext<TestBodyForStatusModuleDependencies, object>(
        container,
        { isTestMode: true },
        {},
      )
      context.registerDependencies({ modules: [new TestBodyForStatusModule()] }, undefined)

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

      client = new SSEInjectClient(server.app)
    })

    afterEach(async () => {
      await server.resources.context.destroy()
      await server.close()
    })

    it('exposes the JSON body of a pre-stream error response', async () => {
      const conn = await client.connect(
        `${bodyForStatusGetContract.pathResolver({})}?mode=unauthorized`,
      )

      expect(conn.getStatusCode()).toBe(401)
      expect(conn.getReceivedEvents()).toHaveLength(0)
      expect(conn.getBody()).toBe(JSON.stringify({ message: 'Unauthorized' }))
      expect(conn.json()).toMatchObject({ message: 'Unauthorized' })
    })

    it('types the parsed body via the json() type parameter', async () => {
      const conn = await client.connect(`${bodyForStatusGetContract.pathResolver({})}?mode=missing`)

      expect(conn.getStatusCode()).toBe(404)

      const body = conn.json<{ resourceId: string }>()
      expectTypeOf(body).toEqualTypeOf<{ resourceId: string }>()
      expect(body.resourceId).toBe('item-42')
    })

    it('exposes the raw stream body for a streaming response', async () => {
      const conn = await client.connect(bodyForStatusGetContract.pathResolver({}))

      expect(conn.getStatusCode()).toBe(200)
      expect(conn.getBody()).toContain('event: message')
      // A text/event-stream body is not JSON
      expect(() => conn.json()).toThrow('json() — body is not valid JSON')
    })
  })

  describe('methods beyond POST', () => {
    let server: SSETestServerWithResources<undefined>
    let client: SSEInjectClient

    beforeEach(async () => {
      // A raw route, since the contract DSL has no DELETE SSE builder - this is
      // about `connectWithBody` accepting every method inject() takes
      server = await createSSETestServer((app) => {
        app.delete('/api/raw-delete-stream', (request, reply) => {
          reply.header('content-type', 'text/event-stream')
          return `event: chunk\ndata: ${JSON.stringify(request.body)}\n\n`
        })
      })

      client = new SSEInjectClient(server.app)
    })

    afterEach(async () => {
      await server.close()
    })

    it('streams a DELETE request carrying a body', async () => {
      const conn = await client.connectWithBody(
        '/api/raw-delete-stream',
        { id: 'to-delete' },
        { method: 'DELETE' },
      )

      expect(conn.getStatusCode()).toBe(200)

      const events = conn.getReceivedEvents()
      expect(events).toHaveLength(1)
      expect(JSON.parse(events[0]!.data)).toEqual({ id: 'to-delete' })
    })
  })
})
