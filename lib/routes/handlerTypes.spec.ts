import { describe, expectTypeOf, it } from 'vitest'
import { z } from 'zod/v4'
import { buildContract } from '../contracts/contractBuilders.ts'
import type { InferDualModeHandlers } from './fastifyRouteTypes.ts'
import { buildHandler } from './fastifyRouteTypes.ts'

describe('Handler Type Enforcement', () => {
  describe('Dual-mode contracts (syncResponseBody)', () => {
    const dualModeContract = buildContract({
      method: 'POST',
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
        method: 'POST',
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
})
