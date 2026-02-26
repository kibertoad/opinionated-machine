import { buildSseContract as buildContract } from '@lokalise/api-contracts'
import { describe, expectTypeOf, it } from 'vitest'
import { z } from 'zod/v4'
import type { InjectPayloadSSEOptions, InjectSSEOptions } from './sseTestTypes.ts'

describe('sseTestTypes type inference', () => {
  describe('InjectSSEOptions', () => {
    it('params should infer the correct type from contract schema, not unknown', () => {
      const contract = buildContract({
        method: 'get',
        pathResolver: (params) => `/api/items/${params.id}/stream`,
        requestPathParamsSchema: z.object({ id: z.string() }),
        requestQuerySchema: z.object({ limit: z.number() }),
        requestHeaderSchema: z.object({ authorization: z.string() }),
        serverSentEventSchemas: { data: z.object({ value: z.string() }) },
      })

      type Options = InjectSSEOptions<typeof contract>

      // These should be the specific schema types, not unknown
      expectTypeOf<Options['params']>().toEqualTypeOf<{ id: string } | undefined>()
      expectTypeOf<Options['query']>().toEqualTypeOf<{ limit: number } | undefined>()
      expectTypeOf<Options['headers']>().toEqualTypeOf<{ authorization: string } | undefined>()
    })
  })

  describe('InjectPayloadSSEOptions', () => {
    it('params should infer the correct type from contract schema, not unknown', () => {
      const contract = buildContract({
        method: 'post',
        pathResolver: (params) => `/api/items/${params.id}/process`,
        requestPathParamsSchema: z.object({ id: z.string() }),
        requestQuerySchema: z.object({ verbose: z.boolean() }),
        requestHeaderSchema: z.object({ authorization: z.string() }),
        requestBodySchema: z.object({ data: z.string() }),
        serverSentEventSchemas: { progress: z.object({ percent: z.number() }) },
      })

      type Options = InjectPayloadSSEOptions<typeof contract>

      // These should be the specific schema types, not unknown
      expectTypeOf<Options['params']>().toEqualTypeOf<{ id: string } | undefined>()
      expectTypeOf<Options['query']>().toEqualTypeOf<{ verbose: boolean } | undefined>()
      expectTypeOf<Options['headers']>().toEqualTypeOf<{ authorization: string } | undefined>()
      expectTypeOf<Options['body']>().toEqualTypeOf<{ data: string }>()
    })
  })
})
