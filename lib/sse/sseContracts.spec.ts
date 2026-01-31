import { describe, expect, it } from 'vitest'
import { z } from 'zod/v4'
import { buildContract } from '../contracts/contractBuilders.ts'
import { buildFastifySSEHandler } from './fastifySSETypes.ts'

describe('sseContracts', () => {
  describe('buildContract (SSE with body)', () => {
    const baseConfig = {
      pathResolver: () => '/api/test',
      params: z.object({}),
      query: z.object({}),
      requestHeaders: z.object({}),
      body: z.object({ message: z.string() }),
      events: {
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
        events: {
          message: z.object({ text: z.string() }),
        },
      })

      expect(route.method).toBe('GET')
      expect(route.pathResolver({})).toBe('/api/stream')
      expect(route.isSSE).toBe(true)
      expect(route.body).toBeUndefined()
    })
  })

  describe('buildFastifySSEHandler type checking', () => {
    const testContract = buildContract({
      method: 'POST',
      pathResolver: (params) => `/api/test/${params.id}/stream`,
      params: z.object({ id: z.string() }),
      query: z.object({ filter: z.string().optional() }),
      requestHeaders: z.object({ authorization: z.string() }),
      body: z.object({ message: z.string(), count: z.number() }),
      events: {
        chunk: z.object({ content: z.string() }),
        done: z.object({ totalTokens: z.number() }),
      },
    })

    it('allows valid event names and payloads', () => {
      const handler = buildFastifySSEHandler(testContract, async (_request, connection) => {
        await connection.send('chunk', { content: 'hello' })
        await connection.send('done', { totalTokens: 42 })
      })

      expect(handler).toBeDefined()
    })

    it('rejects invalid event name at compile time', () => {
      buildFastifySSEHandler(testContract, async (_request, connection) => {
        // @ts-expect-error - 'invalid' is not a valid event name
        await connection.send('invalid', { content: 'test' })
      })

      expect(true).toBe(true)
    })

    it('rejects wrong payload at compile time', () => {
      buildFastifySSEHandler(testContract, async (_request, connection) => {
        // @ts-expect-error - chunk expects { content: string }, not { totalTokens: number }
        await connection.send('chunk', { totalTokens: 42 })
      })

      expect(true).toBe(true)
    })

    it('rejects missing required field at compile time', () => {
      buildFastifySSEHandler(testContract, async (_request, connection) => {
        // @ts-expect-error - done requires totalTokens field
        await connection.send('done', {})
      })

      expect(true).toBe(true)
    })

    it('rejects wrong field type at compile time', () => {
      buildFastifySSEHandler(testContract, async (_request, connection) => {
        // @ts-expect-error - totalTokens should be number, not string
        await connection.send('done', { totalTokens: 'not a number' })
      })

      expect(true).toBe(true)
    })

    it('types request body from contract', () => {
      buildFastifySSEHandler(testContract, (request, _connection) => {
        const message: string = request.body.message
        const count: number = request.body.count

        // @ts-expect-error - nonExistent does not exist on body
        const _invalid = request.body.nonExistent

        expect(message).toBeDefined()
        expect(count).toBeDefined()
      })

      expect(true).toBe(true)
    })

    it('types request params from contract', () => {
      buildFastifySSEHandler(testContract, (request, _connection) => {
        const id: string = request.params.id

        // @ts-expect-error - nonExistent does not exist on params
        const _invalid = request.params.nonExistent

        expect(id).toBeDefined()
      })

      expect(true).toBe(true)
    })
  })

  // More comprehensive type safety tests with full controller implementations
  // are in test/sse/sseTypeSafety.spec.ts
})
