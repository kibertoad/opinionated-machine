import { describe, expect, it } from 'vitest'
import { z } from 'zod/v4'
import { buildPayloadSSERoute, buildSSERoute } from './sseContracts.ts'

describe('sseContracts', () => {
  describe('buildPayloadSSERoute', () => {
    const baseConfig = {
      path: '/api/test' as const,
      params: z.object({}),
      query: z.object({}),
      requestHeaders: z.object({}),
      body: z.object({ message: z.string() }),
      events: {
        data: z.object({ value: z.string() }),
      },
    }

    it('defaults method to POST when not specified', () => {
      const route = buildPayloadSSERoute(baseConfig)

      expect(route.method).toBe('POST')
      expect(route.path).toBe('/api/test')
      expect(route.isSSE).toBe(true)
    })

    it('uses specified method when provided', () => {
      const route = buildPayloadSSERoute({
        ...baseConfig,
        method: 'PUT',
      })

      expect(route.method).toBe('PUT')
    })

    it('supports PATCH method', () => {
      const route = buildPayloadSSERoute({
        ...baseConfig,
        method: 'PATCH',
      })

      expect(route.method).toBe('PATCH')
    })
  })

  describe('buildSSERoute', () => {
    it('creates GET SSE route', () => {
      const route = buildSSERoute({
        path: '/api/stream' as const,
        params: z.object({}),
        query: z.object({ userId: z.string() }),
        requestHeaders: z.object({}),
        events: {
          message: z.object({ text: z.string() }),
        },
      })

      expect(route.method).toBe('GET')
      expect(route.path).toBe('/api/stream')
      expect(route.isSSE).toBe(true)
      expect(route.body).toBeUndefined()
    })
  })
})
