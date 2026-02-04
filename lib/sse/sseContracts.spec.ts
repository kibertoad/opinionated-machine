import { describe, expect, it } from 'vitest'
import { z } from 'zod/v4'
import { buildContract } from '../contracts/contractBuilders.ts'
import { buildHandler } from '../routes/fastifyRouteTypes.ts'

describe('sseContracts', () => {
  describe('buildContract (SSE with body)', () => {
    const baseConfig = {
      pathResolver: () => '/api/test',
      params: z.object({}),
      query: z.object({}),
      requestHeaders: z.object({}),
      requestBody: z.object({ message: z.string() }),
      sseEvents: {
        data: z.object({ value: z.string() }),
      },
    }

    it('defaults method to POST when not specified', () => {
      const route = buildContract(baseConfig)

      expect(route.method).toBe('POST')
      expect(route.pathResolver({})).toBe('/api/test')
      expect(route.isSSE).toBe(true)
    })

    it('uses specified method when provided', () => {
      const route = buildContract({
        ...baseConfig,
        method: 'PUT',
      })

      expect(route.method).toBe('PUT')
    })

    it('supports PATCH method', () => {
      const route = buildContract({
        ...baseConfig,
        method: 'PATCH',
      })

      expect(route.method).toBe('PATCH')
    })
  })

  describe('buildContract (SSE GET)', () => {
    it('creates GET SSE route', () => {
      const route = buildContract({
        pathResolver: () => '/api/stream',
        params: z.object({}),
        query: z.object({ userId: z.string() }),
        requestHeaders: z.object({}),
        sseEvents: {
          message: z.object({ text: z.string() }),
        },
      })

      expect(route.method).toBe('GET')
      expect(route.pathResolver({})).toBe('/api/stream')
      expect(route.isSSE).toBe(true)
      expect(route.requestBody).toBeUndefined()
    })
  })

  describe('buildHandler type checking', () => {
    const testContract = buildContract({
      method: 'POST',
      pathResolver: (params) => `/api/test/${params.id}/stream`,
      params: z.object({ id: z.string() }),
      query: z.object({ filter: z.string().optional() }),
      requestHeaders: z.object({ authorization: z.string() }),
      requestBody: z.object({ message: z.string(), count: z.number() }),
      sseEvents: {
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
