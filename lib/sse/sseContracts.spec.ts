import { buildSseContract as buildContract } from '@lokalise/api-contracts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod/v4'
import { buildHandler } from '../routes/fastifyRouteTypes.ts'

describe('sseContracts', () => {
  describe('buildContract (SSE with body)', () => {
    const baseFields = {
      pathResolver: () => '/api/test',
      requestPathParamsSchema: z.object({}),
      requestQuerySchema: z.object({}),
      requestHeaderSchema: z.object({}),
      requestBodySchema: z.object({ message: z.string() }),
      serverSentEventSchemas: {
        data: z.object({ value: z.string() }),
      },
    }

    it('creates post SSE route', () => {
      const route = buildContract({ method: 'post', ...baseFields })

      expect(route.method).toBe('post')
      expect(route.pathResolver({})).toBe('/api/test')
      expect(route.isSSE).toBe(true)
    })

    it('uses specified method when provided', () => {
      const route = buildContract({
        method: 'put',
        ...baseFields,
      })

      expect(route.method).toBe('put')
    })

    it('supports patch method', () => {
      const route = buildContract({
        method: 'patch',
        ...baseFields,
      })

      expect(route.method).toBe('patch')
    })
  })

  describe('buildContract (SSE GET)', () => {
    it('creates get SSE route', () => {
      const route = buildContract({
        method: 'get',
        pathResolver: () => '/api/stream',
        requestPathParamsSchema: z.object({}),
        requestQuerySchema: z.object({ userId: z.string() }),
        requestHeaderSchema: z.object({}),
        serverSentEventSchemas: {
          message: z.object({ text: z.string() }),
        },
      })

      expect(route.method).toBe('get')
      expect(route.pathResolver({})).toBe('/api/stream')
      expect(route.isSSE).toBe(true)
      expect(route.requestBodySchema).toBeUndefined()
    })
  })

  describe('buildHandler type checking', () => {
    const testContract = buildContract({
      method: 'post',
      pathResolver: (params) => `/api/test/${params.id}/stream`,
      requestPathParamsSchema: z.object({ id: z.string() }),
      requestQuerySchema: z.object({ filter: z.string().optional() }),
      requestHeaderSchema: z.object({ authorization: z.string() }),
      requestBodySchema: z.object({ message: z.string(), count: z.number() }),
      serverSentEventSchemas: {
        chunk: z.object({ content: z.string() }),
        done: z.object({ totalTokens: z.number() }),
      },
    })

    it('allows valid event names and payloads', () => {
      const handlers = buildHandler(testContract, {
        sse: async (_request, sse) => {
          const connection = sse.start('autoClose')
          await connection.send('chunk', { content: 'hello' })
          await connection.send('done', { totalTokens: 42 })
          // autoClose mode
        },
      })

      expect(handlers).toBeDefined()
    })

    it('rejects invalid event name at compile time', () => {
      buildHandler(testContract, {
        sse: async (_request, sse) => {
          const connection = sse.start('autoClose')
          // @ts-expect-error - 'invalid' is not a valid event name
          await connection.send('invalid', { content: 'test' })
          // autoClose mode
        },
      })

      expect(true).toBe(true)
    })

    it('rejects wrong payload at compile time', () => {
      buildHandler(testContract, {
        sse: async (_request, sse) => {
          const connection = sse.start('autoClose')
          // @ts-expect-error - chunk expects { content: string }, not { totalTokens: number }
          await connection.send('chunk', { totalTokens: 42 })
          // autoClose mode
        },
      })

      expect(true).toBe(true)
    })

    it('rejects missing required field at compile time', () => {
      buildHandler(testContract, {
        sse: async (_request, sse) => {
          const connection = sse.start('autoClose')
          // @ts-expect-error - done requires totalTokens field
          await connection.send('done', {})
          // autoClose mode
        },
      })

      expect(true).toBe(true)
    })

    it('rejects wrong field type at compile time', () => {
      buildHandler(testContract, {
        sse: async (_request, sse) => {
          const connection = sse.start('autoClose')
          // @ts-expect-error - totalTokens should be number, not string
          await connection.send('done', { totalTokens: 'not a number' })
          // autoClose mode
        },
      })

      expect(true).toBe(true)
    })

    it('types request body from contract', () => {
      buildHandler(testContract, {
        sse: (request, sse) => {
          const message: string = request.body.message
          const count: number = request.body.count

          // @ts-expect-error - nonExistent does not exist on body
          const _invalid = request.body.nonExistent

          expect(message).toBeDefined()
          expect(count).toBeDefined()
          sse.start('autoClose')
        },
      })

      expect(true).toBe(true)
    })

    it('types request params from contract', () => {
      buildHandler(testContract, {
        sse: (request, sse) => {
          const id: string = request.params.id

          // @ts-expect-error - nonExistent does not exist on params
          const _invalid = request.params.nonExistent

          expect(id).toBeDefined()
          sse.start('autoClose')
        },
      })

      expect(true).toBe(true)
    })
  })

  // More comprehensive type safety tests with full controller implementations
  // are in test/sse/sseTypeSafety.spec.ts
})
