import { buildSseContract as buildContract } from '@lokalise/api-contracts'
import type { InjectOptions } from 'fastify'
import { describe, expectTypeOf, it } from 'vitest'
import { z } from 'zod/v4'
import type {
  InjectPayloadSSEOptions,
  InjectSSEOptions,
  SSEConnectOptions,
  SSEInjectMethod,
} from './sseTestTypes.ts'

describe('sseTestTypes type inference', () => {
  describe('SSEInjectMethod', () => {
    it('covers every method inject() accepts, in both spellings', () => {
      expectTypeOf<SSEInjectMethod>().toEqualTypeOf<NonNullable<InjectOptions['method']>>()

      expectTypeOf<'DELETE'>().toExtend<SSEInjectMethod>()
      expectTypeOf<'delete'>().toExtend<SSEInjectMethod>()
      expectTypeOf<'HEAD'>().toExtend<SSEInjectMethod>()
      expectTypeOf<'OPTIONS'>().toExtend<SSEInjectMethod>()
      expectTypeOf<'get'>().toExtend<SSEInjectMethod>()
      expectTypeOf<'post'>().toExtend<SSEInjectMethod>()
      expectTypeOf<'put'>().toExtend<SSEInjectMethod>()
      expectTypeOf<'patch'>().toExtend<SSEInjectMethod>()
    })

    it('excludes methods inject() does not accept', () => {
      // Fastify's own HTTPMethods is wider than what inject() takes
      expectTypeOf<'SEARCH'>().not.toExtend<SSEInjectMethod>()
    })

    it('is what connect options accept, so consumers never redeclare it', () => {
      expectTypeOf<SSEConnectOptions['method']>().toEqualTypeOf<SSEInjectMethod | undefined>()
    })
  })

  describe('InjectSSEOptions', () => {
    it('params should infer the correct type from contract schema, not unknown', () => {
      const contract = buildContract({
        visibility: 'public',
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
        visibility: 'public',
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
