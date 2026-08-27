import { createContainer } from 'awilix'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest'
import { DIContext, injectApiSSE, parseSSEEvents } from '../../index.js'
import { createSSETestServer, type SSETestServerWithResources } from '../sseTestServerFactory.js'
import { apiLqaSegmentContract, apiTickStreamContract } from './fixtures/testContracts.ts'
import {
  TestApiInjectSSEModule,
  type TestApiInjectSSEModuleControllers,
} from './fixtures/testModules.ts'

type TestContext = DIContext<TestApiInjectSSEModuleControllers, object>

describe('injectApiSSE — defineApiContract SSE routes', () => {
  let server: SSETestServerWithResources<{ context: TestContext }>
  let context: TestContext

  beforeEach(async () => {
    const container = createContainer<TestApiInjectSSEModuleControllers>({
      injectionMode: 'PROXY',
    })
    context = new DIContext<TestApiInjectSSEModuleControllers, object>(container, {}, {})
    context.registerDependencies({ modules: [new TestApiInjectSSEModule()] }, undefined)

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

  // ==========================================================================
  // POST + body
  // ==========================================================================

  describe('POST contracts', () => {
    it('streams the contract events for a POST-with-body contract', async () => {
      const { closed } = injectApiSSE(server.app, apiLqaSegmentContract, {
        body: { segment: 'hello' },
      })

      const response = await closed

      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain('text/event-stream')
      expect(parseSSEEvents(response.body).map((event) => event.event)).toEqual(['review', 'done'])
    })

    it('returns events typed and validated against the contract schemas', async () => {
      const events = await injectApiSSE(server.app, apiLqaSegmentContract, {
        body: { segment: 'hello' },
      }).events()

      expect(events).toEqual([
        { event: 'review', data: { score: 5 } },
        { event: 'done', data: { total: 1 } },
      ])

      const review = events[0]!
      if (review.event === 'review') {
        expectTypeOf(review.data).toEqualTypeOf<{ score: number }>()
      }
    })

    it('parses a documented pre-stream error body via bodyForStatus', async () => {
      const { bodyForStatus } = injectApiSSE(server.app, apiLqaSegmentContract, {
        body: { segment: '' },
      })

      const body = await bodyForStatus(400)

      // Typed as the contract's 400 schema, not `never`/`unknown`.
      expectTypeOf(body).toEqualTypeOf<{ message: string }>()
      expect(body).toEqual({ message: 'segment must not be empty' })
    })

    it('rejects status codes the contract does not declare', () => {
      const { bodyForStatus } = injectApiSSE(server.app, apiLqaSegmentContract, {
        body: { segment: 'hello' },
      })

      // @ts-expect-error — 503 is not declared by the contract
      expect(() => bodyForStatus(503)).toBeDefined()
    })
  })

  // ==========================================================================
  // GET + path params / query params / headers
  // ==========================================================================

  describe('GET contracts', () => {
    it('resolves path params, query params and headers from the contract', async () => {
      const events = await injectApiSSE(server.app, apiTickStreamContract, {
        pathParams: { channelId: 'c-1' },
        queryParams: { count: 2 },
        headers: { authorization: 'Bearer valid-token' },
      }).events()

      expect(events).toEqual([
        { event: 'tick', data: { channelId: 'c-1', n: 1 } },
        { event: 'tick', data: { channelId: 'c-1', n: 2 } },
      ])
    })

    it('accepts an async headers factory', async () => {
      const { closed } = injectApiSSE(server.app, apiTickStreamContract, {
        pathParams: { channelId: 'c-2' },
        queryParams: { count: 1 },
        headers: async () => ({ authorization: 'Bearer valid-token' }),
      })

      expect((await closed).statusCode).toBe(200)
    })

    it('parses the documented 401 body via bodyForStatus', async () => {
      const body = await injectApiSSE(server.app, apiTickStreamContract, {
        pathParams: { channelId: 'c-3' },
        queryParams: { count: 1 },
        headers: { authorization: 'Bearer nope' },
      }).bodyForStatus(401)

      expectTypeOf(body).toEqualTypeOf<{ message: string }>()
      expect(body).toEqual({ message: 'Unauthorized' })
    })

    it('fails events() with a pointer to bodyForStatus when the response is not a stream', async () => {
      const { events } = injectApiSSE(server.app, apiTickStreamContract, {
        pathParams: { channelId: 'c-4' },
        queryParams: { count: 1 },
        headers: { authorization: 'Bearer nope' },
      })

      await expect(events()).rejects.toThrow(
        /response is not an SSE stream .*bodyForStatus\(401\)/s,
      )
    })
  })
})
