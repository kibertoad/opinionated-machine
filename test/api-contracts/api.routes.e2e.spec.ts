import { createContainer } from 'awilix'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DIContext, SSEHttpClient, SSEInjectClient } from '../../index.js'
import { buildApiRoute } from '../../lib/api-contracts/index.ts'
import { createSSETestServer, type SSETestServerWithResources } from '../sseTestServerFactory.js'
import { apiSseOnConnectContract } from './fixtures/testContracts.ts'
import { TestApiModule, type TestApiModuleControllers } from './fixtures/testModules.ts'

type TestContext = DIContext<TestApiModuleControllers, object>

describe('AbstractApiController — non-SSE and dual-mode E2E', () => {
  let server: SSETestServerWithResources<{ context: TestContext }>
  let context: TestContext

  beforeEach(async () => {
    const container = createContainer<TestApiModuleControllers>({ injectionMode: 'PROXY' })
    context = new DIContext<TestApiModuleControllers, object>(container, {}, {})
    context.registerDependencies({ modules: [new TestApiModule()] }, undefined)

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

  describe('non-SSE routes', () => {
    it('GET returns JSON body', async () => {
      const response = await server.app.inject({
        method: 'GET',
        url: '/api/users/alice',
      })

      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain('application/json')
      expect(JSON.parse(response.body)).toEqual({ id: 'alice', name: 'Alice' })
    })

    it('POST returns 201 with body from request', async () => {
      const response = await server.app.inject({
        method: 'POST',
        url: '/api/users',
        headers: { 'content-type': 'application/json' },
        payload: { name: 'Bob' },
      })

      expect(response.statusCode).toBe(201)
      expect(JSON.parse(response.body)).toEqual({ id: '1', name: 'Bob' })
    })

    it('GET returns 400 for missing required params', async () => {
      const response = await server.app.inject({
        method: 'POST',
        url: '/api/users',
        headers: { 'content-type': 'application/json' },
        payload: {},
      })

      expect(response.statusCode).toBe(400)
    })
  })

  describe('dual-mode route', () => {
    it('returns JSON when Accept is application/json', async () => {
      const response = await server.app.inject({
        method: 'GET',
        url: '/api/feed',
        headers: { accept: 'application/json' },
      })

      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain('application/json')
      expect(JSON.parse(response.body)).toMatchObject({ id: 'summary' })
    })

    it('returns JSON with query param reflected', async () => {
      const response = await server.app.inject({
        method: 'GET',
        url: '/api/feed?limit=5',
        headers: { accept: 'application/json' },
      })

      expect(response.statusCode).toBe(200)
      expect(JSON.parse(response.body)).toMatchObject({ name: 'limit=5' })
    })

    it('streams SSE when Accept is text/event-stream', { timeout: 10000 }, async () => {
      const client = await SSEHttpClient.connect(server.baseUrl, '/api/feed')

      const events = await client.collectEvents(1, 5000)
      expect(events).toHaveLength(1)
      expect(JSON.parse(events[0]!.data)).toEqual({ value: 42 })

      client.close()
    })
  })

  describe('keepAlive SSE route', () => {
    it('streams events and keeps connection open', { timeout: 10000 }, async () => {
      const client = await SSEHttpClient.connect(server.baseUrl, '/api/test/sse-keep-alive')

      const events = await client.collectEvents(1, 5000)
      client.close()

      expect(events).toHaveLength(1)
      expect(JSON.parse(events[0]!.data)).toEqual({ n: 1 })
    })
  })

  describe('sendStream SSE route', () => {
    it('sends multiple events via session.sendStream()', async () => {
      const client = new SSEInjectClient(server.app)
      const conn = await client.connect('/api/test/sse-stream')

      const events = conn.getReceivedEvents().filter((e) => e.event === 'item')
      expect(events).toHaveLength(2)
      expect(JSON.parse(events[0]!.data)).toEqual({ i: 1 })
      expect(JSON.parse(events[1]!.data)).toEqual({ i: 2 })
    })
  })
})

describe('AbstractApiController — SSE lifecycle hooks', () => {
  let lifecycleServer: SSETestServerWithResources<undefined>
  const onConnectCalls: number[] = []

  beforeEach(async () => {
    onConnectCalls.length = 0

    lifecycleServer = await createSSETestServer((app) => {
      app.route(
        buildApiRoute(
          apiSseOnConnectContract,
          async (_req, sse) => {
            const session = sse.start('autoClose')
            await session.send('ping', { seq: 1 })
          },
          {
            onConnect: () => {
              onConnectCalls.push(1)
            },
            onClose: () => {},
          },
        ),
      )
    })
  })

  afterEach(async () => {
    await lifecycleServer.close()
  })

  it('fires onConnect callback when SSE session starts', async () => {
    const client = new SSEInjectClient(lifecycleServer.app)
    const conn = await client.connect('/api/test/sse-on-connect')

    expect(conn.getReceivedEvents().some((e) => e.event === 'ping')).toBe(true)
    expect(onConnectCalls).toHaveLength(1)
  })
})
