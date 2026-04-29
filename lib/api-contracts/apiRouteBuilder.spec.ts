import {
  anyOfResponses,
  ContractNoBody,
  defineApiContract,
  sseResponse,
} from '@lokalise/api-contracts'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod/v4'
import { buildApiRoute } from './apiRouteBuilder.ts'

// ============================================================================
// Shared test fixtures
// ============================================================================

const userSchema = z.object({ id: z.string(), name: z.string() })

const getUserContract = defineApiContract({
  method: 'get',
  pathResolver: (p: { userId: string }) => `/users/${p.userId}`,
  requestPathParamsSchema: z.object({ userId: z.string() }),
  responsesByStatusCode: { 200: userSchema },
})

const createUserContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/users',
  requestBodySchema: z.object({ name: z.string() }),
  responsesByStatusCode: { 201: userSchema },
})

const deleteUserContract = defineApiContract({
  method: 'delete',
  pathResolver: (p: { userId: string }) => `/users/${p.userId}`,
  requestPathParamsSchema: z.object({ userId: z.string() }),
  responsesByStatusCode: { 204: ContractNoBody },
})

const sseEventsSchema = {
  update: z.object({ value: z.number() }),
  done: z.object({ total: z.number() }),
}

const sseOnlyContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/stream',
  responsesByStatusCode: { 200: sseResponse(sseEventsSchema) },
})

const dualModeContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/chat',
  requestBodySchema: z.object({ message: z.string() }),
  responsesByStatusCode: {
    200: anyOfResponses([userSchema, sseResponse(sseEventsSchema)]),
  },
})

// ============================================================================
// buildApiRoute — non-SSE contracts
// ============================================================================

describe('buildApiRoute — non-SSE', () => {
  it('produces a GET route with correct method and url', () => {
    const routeOptions = buildApiRoute(getUserContract, async () => ({
      status: 200,
      body: { id: '1', name: 'Alice' },
    }))
    expect(routeOptions.method).toBe('get')
    expect(routeOptions.url).toBe('/users/:userId')
  })

  it('includes path params schema', () => {
    const routeOptions = buildApiRoute(getUserContract, async () => ({
      status: 200,
      body: { id: '1', name: 'Alice' },
    }))
    expect((routeOptions.schema as { params?: unknown })?.params).toBe(
      getUserContract.requestPathParamsSchema,
    )
  })

  it('produces a POST route with body schema', () => {
    const routeOptions = buildApiRoute(createUserContract, async () => ({
      status: 201,
      body: { id: '1', name: 'Alice' },
    }))
    expect(routeOptions.method).toBe('post')
    expect((routeOptions.schema as { body?: unknown })?.body).toBe(
      createUserContract.requestBodySchema,
    )
  })

  it('excludes body schema for ContractNoBody', () => {
    const routeOptions = buildApiRoute(deleteUserContract, async () => ({
      status: 204,
      body: undefined,
    }))
    expect((routeOptions.schema as { body?: unknown })?.body).toBeUndefined()
  })

  it('does not set sse property on non-SSE routes', () => {
    const routeOptions = buildApiRoute(getUserContract, async () => ({
      status: 200,
      body: { id: '1', name: 'Alice' },
    }))
    expect((routeOptions as { sse?: unknown }).sse).toBeUndefined()
  })

  it('attaches preHandler when provided in options', () => {
    const preHandler = vi.fn()
    const routeOptions = buildApiRoute(
      getUserContract,
      async () => ({ status: 200, body: { id: '1', name: 'Alice' } }),
      { preHandler },
    )
    expect(routeOptions.preHandler).toBe(preHandler)
  })
})

// ============================================================================
// buildApiRoute — SSE-only contracts
// ============================================================================

describe('buildApiRoute — SSE-only', () => {
  it('produces a route with sse: true', () => {
    const routeOptions = buildApiRoute(sseOnlyContract, (_request, sse) => {
      sse.start('keepAlive')
    })
    expect((routeOptions as { sse?: unknown }).sse).toBe(true)
  })

  it('produces correct url', () => {
    const routeOptions = buildApiRoute(sseOnlyContract, (_request, sse) => {
      sse.start('keepAlive')
    })
    expect(routeOptions.url).toBe('/stream')
  })
})

// ============================================================================
// buildApiRoute — dual-mode contracts
// ============================================================================

describe('buildApiRoute — dual-mode', () => {
  it('produces a route with sse: true', () => {
    const routeOptions = buildApiRoute(dualModeContract, {
      nonSse: async () => ({ status: 200, body: { id: '1', name: 'Alice' } }),
      sse: (_request, sse) => {
        sse.start('autoClose')
      },
    })
    expect((routeOptions as { sse?: unknown }).sse).toBe(true)
  })

  it('produces correct url and method', () => {
    const routeOptions = buildApiRoute(dualModeContract, {
      nonSse: async () => ({ status: 200, body: { id: '1', name: 'Alice' } }),
      sse: (_request, sse) => {
        sse.start('autoClose')
      },
    })
    expect(routeOptions.method).toBe('post')
    expect(routeOptions.url).toBe('/chat')
  })

  it('includes body schema', () => {
    const routeOptions = buildApiRoute(dualModeContract, {
      nonSse: async () => ({ status: 200, body: { id: '1', name: 'Alice' } }),
      sse: (_request, sse) => {
        sse.start('autoClose')
      },
    })
    expect((routeOptions.schema as { body?: unknown })?.body).toBe(
      dualModeContract.requestBodySchema,
    )
  })
})

// ============================================================================
// buildApiRoute — custom SSE config options
// ============================================================================

describe('buildApiRoute — SSE config via options', () => {
  it('passes custom serializer into sse config', () => {
    const serializer = (data: unknown) => JSON.stringify(data)
    const routeOptions = buildApiRoute(
      sseOnlyContract,
      (_r, sse) => {
        sse.start('keepAlive')
      },
      { serializer },
    )
    expect((routeOptions as { sse?: unknown }).sse).toEqual({ serializer })
  })

  it('passes heartbeatInterval into sse config', () => {
    const routeOptions = buildApiRoute(
      sseOnlyContract,
      (_r, sse) => {
        sse.start('keepAlive')
      },
      { heartbeatInterval: 10000 },
    )
    expect((routeOptions as { sse?: unknown }).sse).toEqual({ heartbeatInterval: 10000 })
  })
})

// ============================================================================
// buildApiRoute — no-path-params contract
// ============================================================================

describe('buildApiRoute — no path params', () => {
  it('produces correct url for contract without path params', () => {
    const routeOptions = buildApiRoute(createUserContract, async () => ({
      status: 201,
      body: { id: '1', name: 'Alice' },
    }))
    expect(routeOptions.url).toBe('/users')
    expect((routeOptions.schema as { params?: unknown })?.params).toBeUndefined()
  })
})
