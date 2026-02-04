import { buildSseContract as buildContract } from '@lokalise/api-contracts'
import { describe, expectTypeOf, it } from 'vitest'
import { z } from 'zod/v4'
import type { InferDualModeHandlers } from './fastifyRouteTypes.ts'
import { buildHandler } from './fastifyRouteTypes.ts'

describe('Handler Type Enforcement', () => {
  describe('Dual-mode contracts (syncResponseBody)', () => {
    const dualModeContract = buildContract({
      method: 'post',
      pathResolver: () => '/api/chat',
      params: z.object({}),
      query: z.object({}),
      requestHeaders: z.object({}),
      requestBody: z.object({ message: z.string() }),
      syncResponseBody: z.object({ reply: z.string() }),
      sseEvents: { chunk: z.object({ delta: z.string() }) },
    })

    it('requires sync handler, not json handler', () => {
      type Handlers = InferDualModeHandlers<typeof dualModeContract>

      // Handlers should have 'sync' property
      expectTypeOf<Handlers>().toHaveProperty('sync')
      expectTypeOf<Handlers>().toHaveProperty('sse')

      // Handlers should NOT have 'json' property (deprecated)
      expectTypeOf<Handlers>().not.toHaveProperty('json')
    })

    it('types sync handler return value correctly', () => {
      type Handlers = InferDualModeHandlers<typeof dualModeContract>
      type SyncHandler = Handlers['sync']

      // SyncHandler should return { reply: string }
      expectTypeOf<Awaited<ReturnType<SyncHandler>>>().toExtend<{ reply: string }>()
    })

    it('has sync and sse properties', () => {
      type Handlers = InferDualModeHandlers<typeof dualModeContract>

      // Handlers should have sync and sse properties that are functions
      expectTypeOf<Handlers>().toHaveProperty('sync')
      expectTypeOf<Handlers>().toHaveProperty('sse')

      // Verify both are callable
      type SyncHandler = Handlers['sync']
      type SSEHandler = Handlers['sse']
      expectTypeOf<SyncHandler>().toBeFunction()
      expectTypeOf<SSEHandler>().toBeFunction()
    })
  })

  describe('buildHandler enforces correct handler structure', () => {
    it('accepts valid dual-mode handlers', () => {
      const dualModeContract = buildContract({
        method: 'post',
        pathResolver: () => '/api/chat',
        params: z.object({}),
        query: z.object({}),
        requestHeaders: z.object({}),
        requestBody: z.object({ message: z.string() }),
        syncResponseBody: z.object({ reply: z.string() }),
        sseEvents: { chunk: z.object({ delta: z.string() }) },
      })

      // This should compile without errors
      const container = buildHandler(dualModeContract, {
        sync: () => ({ reply: 'hello' }),
        sse: async (_req, sse) => {
          const connection = sse.start('autoClose')
          await connection.send('chunk', { delta: 'hi' })
          // autoClose mode
        },
      })

      // Container has __type, contract, handlers, options
      expectTypeOf(container).toHaveProperty('__type')
      expectTypeOf(container).toHaveProperty('contract')
      expectTypeOf(container).toHaveProperty('handlers')
      // The actual handlers are in container.handlers
      expectTypeOf(container.handlers).toHaveProperty('sync')
      expectTypeOf(container.handlers).toHaveProperty('sse')
    })

    it('accepts valid SSE-only handlers', () => {
      const sseContract = buildContract({
        pathResolver: () => '/api/stream',
        params: z.object({}),
        query: z.object({}),
        requestHeaders: z.object({}),
        sseEvents: { data: z.object({ value: z.string() }) },
      })

      // This should compile without errors
      const container = buildHandler(sseContract, {
        sse: async (_req, sse) => {
          const connection = sse.start('autoClose')
          await connection.send('data', { value: 'test' })
          // autoClose mode
        },
      })

      // Container has __type, contract, handlers, options
      expectTypeOf(container).toHaveProperty('__type')
      expectTypeOf(container).toHaveProperty('contract')
      expectTypeOf(container).toHaveProperty('handlers')
      // The actual handlers are in container.handlers
      expectTypeOf(container.handlers).toHaveProperty('sse')
    })
  })

  describe('sse.respond() with responseSchemasByStatusCode', () => {
    const contractWithStatusSchemas = buildContract({
      method: 'post',
      pathResolver: () => '/api/resource',
      params: z.object({}),
      query: z.object({}),
      requestHeaders: z.object({}),
      requestBody: z.object({ data: z.string() }),
      syncResponseBody: z.object({ success: z.boolean(), data: z.string() }),
      responseSchemasByStatusCode: {
        400: z.object({ error: z.string(), details: z.array(z.string()) }),
        404: z.object({ error: z.string(), resourceId: z.string() }),
      },
      sseEvents: { result: z.object({ success: z.boolean() }) },
    })

    it('accepts valid sse.respond() calls with correct schema', () => {
      // Strict typing: 404 requires { error: string, resourceId: string }
      const container = buildHandler(contractWithStatusSchemas, {
        sync: () => ({ success: true, data: 'OK' }),
        sse: (_req, sse) => {
          return sse.respond(404, { error: 'Not Found', resourceId: 'item-123' })
        },
      })

      expectTypeOf(container).toHaveProperty('handlers')
    })

    it('accepts valid sse.respond() calls with 400 schema', () => {
      // Strict typing: 400 requires { error: string, details: string[] }
      const container = buildHandler(contractWithStatusSchemas, {
        sync: () => ({ success: true, data: 'OK' }),
        sse: (_req, sse) => {
          return sse.respond(400, { error: 'Bad Request', details: ['invalid input'] })
        },
      })

      expectTypeOf(container).toHaveProperty('handlers')
    })

    it('rejects sse.respond() with 400 schema passed to 404 status', () => {
      buildHandler(contractWithStatusSchemas, {
        sync: () => ({ success: true, data: 'OK' }),
        sse: (_req, sse) => {
          // 404 requires { error: string, resourceId: string }, not { details: string[] }
          // @ts-expect-error - 400 schema passed to 404: requires resourceId, not details
          return sse.respond(404, { error: 'Not Found', details: ['missing'] })
        },
      })
    })

    it('rejects sse.respond() with 404 schema passed to 400 status', () => {
      buildHandler(contractWithStatusSchemas, {
        sync: () => ({ success: true, data: 'OK' }),
        sse: (_req, sse) => {
          // 400 requires { error: string, details: string[] }, not { resourceId: string }
          // @ts-expect-error - 404 schema passed to 400: requires details, not resourceId
          return sse.respond(400, { error: 'Bad Request', resourceId: 'item-123' })
        },
      })
    })

    it('rejects sse.respond() with missing required field', () => {
      buildHandler(contractWithStatusSchemas, {
        sync: () => ({ success: true, data: 'OK' }),
        sse: (_req, sse) => {
          // 404 requires { error: string, resourceId: string }
          // @ts-expect-error - missing resourceId field
          return sse.respond(404, { error: 'Not Found' })
        },
      })
    })

    it('rejects sse.respond() with undefined status code', () => {
      buildHandler(contractWithStatusSchemas, {
        sync: () => ({ success: true, data: 'OK' }),
        sse: (_req, sse) => {
          // 500 is not defined in responseSchemasByStatusCode
          // @ts-expect-error - 500 is not a valid status code for this contract
          return sse.respond(500, { message: 'Internal error' })
        },
      })
    })
  })
})
