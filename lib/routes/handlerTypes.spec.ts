import { describe, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import { buildContract } from '../contracts/contractBuilders.ts'
import type { InferDualModeHandlers, VerboseDualModeHandlers } from './fastifyRouteTypes.ts'
import { buildHandler } from './fastifyRouteTypes.ts'

describe('Handler Type Enforcement', () => {
  describe('Verbose contracts (multiFormatResponses)', () => {
    const verboseContract = buildContract({
      method: 'POST',
      pathResolver: () => '/api/export',
      params: z.object({}),
      query: z.object({}),
      requestHeaders: z.object({}),
      body: z.object({ data: z.string() }),
      multiFormatResponses: {
        'application/json': z.object({ result: z.string() }),
        'text/plain': z.string(),
      },
      events: { done: z.object({ ok: z.boolean() }) },
    })

    it('requires sync handlers, not json handler', () => {
      type VerboseHandlers = InferDualModeHandlers<typeof verboseContract>

      // Should be VerboseDualModeHandlers, not DualModeHandlers
      expectTypeOf<VerboseHandlers>().toExtend<
        VerboseDualModeHandlers<
          {
            'application/json': z.ZodObject<{ result: z.ZodString }>
            'text/plain': z.ZodString
          },
          Record<string, never>,
          Record<string, never>,
          Record<string, never>,
          { data: string },
          { done: z.ZodObject<{ ok: z.ZodBoolean }> }
        >
      >()

      // VerboseHandlers should have 'sync' property
      expectTypeOf<VerboseHandlers>().toHaveProperty('sync')
      expectTypeOf<VerboseHandlers>().toHaveProperty('sse')

      // VerboseHandlers should NOT have 'json' property
      expectTypeOf<VerboseHandlers>().not.toHaveProperty('json')
    })

    it('requires all format handlers in sync', () => {
      type VerboseHandlers = InferDualModeHandlers<typeof verboseContract>
      type SyncHandlers = VerboseHandlers['sync']

      // sync should have handlers for each format
      expectTypeOf<SyncHandlers>().toHaveProperty('application/json')
      expectTypeOf<SyncHandlers>().toHaveProperty('text/plain')
    })
  })

  describe('Simplified contracts (jsonResponse)', () => {
    const simplifiedContract = buildContract({
      method: 'POST',
      pathResolver: () => '/api/chat',
      params: z.object({}),
      query: z.object({}),
      requestHeaders: z.object({}),
      body: z.object({ message: z.string() }),
      jsonResponse: z.object({ reply: z.string() }),
      events: { chunk: z.object({ delta: z.string() }) },
    })

    it('requires json handler, not sync handlers', () => {
      type SimplifiedHandlers = InferDualModeHandlers<typeof simplifiedContract>

      // SimplifiedHandlers should have 'json' property
      expectTypeOf<SimplifiedHandlers>().toHaveProperty('json')
      expectTypeOf<SimplifiedHandlers>().toHaveProperty('sse')

      // SimplifiedHandlers should NOT have 'sync' property
      expectTypeOf<SimplifiedHandlers>().not.toHaveProperty('sync')
    })

    it('types json handler return value correctly', () => {
      type SimplifiedHandlers = InferDualModeHandlers<typeof simplifiedContract>
      type JsonHandler = SimplifiedHandlers['json']

      // JsonHandler should return { reply: string }
      expectTypeOf<Awaited<ReturnType<JsonHandler>>>().toExtend<{ reply: string }>()
    })
  })

  describe('buildHandler enforces correct handler structure', () => {
    it('accepts valid verbose handlers', () => {
      const verboseContract = buildContract({
        method: 'POST',
        pathResolver: () => '/api/export',
        params: z.object({}),
        query: z.object({}),
        requestHeaders: z.object({}),
        body: z.object({ data: z.string() }),
        multiFormatResponses: {
          'application/json': z.object({ result: z.string() }),
          'text/plain': z.string(),
        },
        events: { done: z.object({ ok: z.boolean() }) },
      })

      // This should compile without errors
      const handlers = buildHandler(verboseContract, {
        sync: {
          'application/json': () => ({ result: 'test' }),
          'text/plain': () => 'plain text',
        },
        sse: async (_req, conn) => {
          await conn.send('done', { ok: true })
          return { result: 'disconnect' as const }
        },
      })

      expectTypeOf(handlers).toHaveProperty('sync')
      expectTypeOf(handlers).toHaveProperty('sse')
    })

    it('accepts valid simplified handlers', () => {
      const simplifiedContract = buildContract({
        method: 'POST',
        pathResolver: () => '/api/chat',
        params: z.object({}),
        query: z.object({}),
        requestHeaders: z.object({}),
        body: z.object({ message: z.string() }),
        jsonResponse: z.object({ reply: z.string() }),
        events: { chunk: z.object({ delta: z.string() }) },
      })

      // This should compile without errors
      const handlers = buildHandler(simplifiedContract, {
        json: () => ({ reply: 'hello' }),
        sse: async (_req, conn) => {
          await conn.send('chunk', { delta: 'hi' })
          return { result: 'disconnect' as const }
        },
      })

      expectTypeOf(handlers).toHaveProperty('json')
      expectTypeOf(handlers).toHaveProperty('sse')
    })
  })
})
