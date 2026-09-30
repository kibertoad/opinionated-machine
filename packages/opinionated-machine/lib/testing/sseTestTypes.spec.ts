import type { InjectOptions } from 'fastify'
import { describe, expectTypeOf, it } from 'vitest'
import type { SSEConnectOptions, SSEInjectMethod } from './sseTestTypes.ts'

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
})
