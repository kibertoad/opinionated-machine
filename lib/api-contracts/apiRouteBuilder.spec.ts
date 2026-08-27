import { defineApiContract, sseBody } from '@lokalise/api-contracts'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod/v4'
import { GATEWAY_METADATA_SYMBOL } from '../gateway/gatewaySymbol.ts'
import { readGatewayMetadata, withGatewayMetadata } from '../gateway/withGatewayMetadata.ts'
import { readRouteVisibility } from '../openapi/visibility.ts'
import { buildApiRoute } from './apiRouteBuilder.ts'

// ============================================================================
// Shared test fixtures
// ============================================================================

const userSchema = z.object({ id: z.string(), name: z.string() })

const getUserContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Get user',
  pathResolver: (p: { userId: string }) => `/users/${p.userId}`,
  requestPathParamsSchema: z.object({ userId: z.string() }),
  responsesByStatusCode: { 200: userSchema },
})

const sseEventsSchema = {
  update: z.object({ value: z.number() }),
  done: z.object({ total: z.number() }),
}

const sseOnlyContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Sse only',
  pathResolver: () => '/stream',
  responsesByStatusCode: { 200: { content: { 'text/event-stream': sseBody(sseEventsSchema) } } },
})

const dualModeContract = defineApiContract({
  visibility: 'public',
  method: 'post',
  summary: 'Dual mode',
  pathResolver: () => '/chat',
  requestBodySchema: z.object({ message: z.string() }),
  responsesByStatusCode: {
    200: {
      content: { 'application/json': userSchema, 'text/event-stream': sseBody(sseEventsSchema) },
    },
  },
})

// ============================================================================
// buildApiRoute — delegation to buildFastifyApiRoute
// ============================================================================

describe('buildApiRoute — delegation', () => {
  it('produces a route from the contract (method, url, schema)', () => {
    const routeOptions = buildApiRoute(getUserContract, async () => ({
      status: 200,
      body: { id: '1', name: 'Alice' },
    }))
    expect(routeOptions.method).toBe('get')
    expect(routeOptions.url).toBe('/users/:userId')
    expect((routeOptions.schema as { params?: unknown })?.params).toBe(
      getUserContract.requestPathParamsSchema,
    )
  })

  it('passes Fastify options like preHandler through to the route', () => {
    const preHandler = vi.fn()
    const routeOptions = buildApiRoute(
      getUserContract,
      async () => ({ status: 200, body: { id: '1', name: 'Alice' } }),
      { preHandler },
    )
    expect(routeOptions.preHandler).toBe(preHandler)
  })

  it('marks SSE-capable contracts with the sse route option', () => {
    const routeOptions = buildApiRoute(sseOnlyContract, (_request, _reply, { sse }) => {
      sse.start('keepAlive')
    })
    expect((routeOptions as { sse?: unknown }).sse).toBeDefined()
  })
})

describe('buildApiRoute — OpenAPI visibility', () => {
  const internalContract = defineApiContract({
    visibility: 'internal',
    method: 'post',
    summary: 'Reindex',
    pathResolver: () => '/ops/reindex',
    requestBodySchema: z.object({ full: z.boolean() }),
    responsesByStatusCode: { 200: z.object({ reindexedDocuments: z.number() }) },
  })

  it('records the contract visibility alongside the hide flag', () => {
    const routeOptions = buildApiRoute(internalContract, async () => ({
      status: 200,
      body: { reindexedDocuments: 1 },
    }))

    expect(routeOptions.schema).toMatchObject({ hide: true, visibility: 'internal' })
    expect(readRouteVisibility(routeOptions)).toBe('internal')
  })

  it('records public visibility too, so transforms can widen the public audience', () => {
    const routeOptions = buildApiRoute(getUserContract, async () => ({
      status: 200,
      body: { id: '1', name: 'Alice' },
    }))

    expect(readRouteVisibility(routeOptions)).toBe('public')
  })

  it('leaves routes untouched when the contract has no visibility at runtime', () => {
    const legacyContract = { ...getUserContract }
    delete (legacyContract as { visibility?: unknown }).visibility

    const routeOptions = buildApiRoute(legacyContract, async () => ({
      status: 200,
      body: { id: '1', name: 'Alice' },
    }))

    expect(readRouteVisibility(routeOptions)).toBeUndefined()
  })
})

// ============================================================================
// buildApiRoute — inline gatewayMetadata
// ============================================================================

const headerAwareContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Header aware',
  pathResolver: (p: { tenantId: string }) => `/tenants/${p.tenantId}`,
  requestPathParamsSchema: z.object({ tenantId: z.string() }),
  requestHeaderSchema: z.object({ 'x-trace-id': z.string() }),
  responsesByStatusCode: { 200: userSchema },
})

const queryAwareContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Query aware',
  pathResolver: () => '/search',
  requestQuerySchema: z.object({ q: z.string(), limit: z.coerce.number().optional() }),
  responsesByStatusCode: { 200: userSchema },
})

describe('buildApiRoute — inline gatewayMetadata', () => {
  it('stamps validated metadata onto the route via the shared symbol', () => {
    const routeOptions = buildApiRoute(
      getUserContract,
      async () => ({ status: 200, body: { id: '1', name: 'Alice' } }),
      { gatewayMetadata: { upstream: 'users-service', cache: { ttl: '60s' } } },
    )
    expect(readGatewayMetadata(routeOptions)).toEqual({
      upstream: 'users-service',
      cache: { ttl: '60s' },
    })
  })

  it('does not stamp the symbol when no gatewayMetadata is provided', () => {
    const routeOptions = buildApiRoute(getUserContract, async () => ({
      status: 200,
      body: { id: '1', name: 'Alice' },
    }))
    expect(readGatewayMetadata(routeOptions)).toBeUndefined()
  })

  it('attaches metadata via a non-enumerable symbol (invisible to Fastify)', () => {
    const routeOptions = buildApiRoute(
      getUserContract,
      async () => ({ status: 200, body: { id: '1', name: 'Alice' } }),
      { gatewayMetadata: { upstream: 'users-service' } },
    )
    expect(Object.keys(routeOptions)).not.toContain(GATEWAY_METADATA_SYMBOL.toString())
    expect(Object.getOwnPropertyDescriptor(routeOptions, GATEWAY_METADATA_SYMBOL)?.enumerable).toBe(
      false,
    )
  })

  it('does not leak gatewayMetadata as an own property on the Fastify route', () => {
    const routeOptions = buildApiRoute(
      getUserContract,
      async () => ({ status: 200, body: { id: '1', name: 'Alice' } }),
      { gatewayMetadata: { upstream: 'users-service' } },
    )
    expect((routeOptions as { gatewayMetadata?: unknown }).gatewayMetadata).toBeUndefined()
  })

  it('throws at the call site when metadata is malformed (cache.ttl)', () => {
    expect(() =>
      buildApiRoute(
        getUserContract,
        async () => ({ status: 200, body: { id: '1', name: 'Alice' } }),
        { gatewayMetadata: { cache: { ttl: 'not-a-duration' } } as never },
      ),
    ).toThrow()
  })

  it('accepts contract-typed match.headers keys and reads them back', () => {
    const routeOptions = buildApiRoute(
      headerAwareContract,
      async () => ({ status: 200, body: { id: '1', name: 'Alice' } }),
      {
        gatewayMetadata: {
          match: { headers: { 'x-trace-id': { regex: '^[a-f0-9]+$' } } },
        },
      },
    )
    expect(readGatewayMetadata(routeOptions)?.match?.headers?.['x-trace-id']).toEqual({
      regex: '^[a-f0-9]+$',
    })
  })

  it('customHeaders accepts free-form keys for headers not in the contract', () => {
    const routeOptions = buildApiRoute(
      headerAwareContract,
      async () => ({ status: 200, body: { id: '1', name: 'Alice' } }),
      {
        gatewayMetadata: {
          match: { customHeaders: { 'x-cf-tenant': 'enterprise' } },
        },
      },
    )
    expect(readGatewayMetadata(routeOptions)?.match?.customHeaders).toEqual({
      'x-cf-tenant': 'enterprise',
    })
  })

  it('stamps metadata on SSE-only routes', () => {
    const routeOptions = buildApiRoute(
      sseOnlyContract,
      (_request, _reply, { sse }) => {
        sse.start('keepAlive')
      },
      { gatewayMetadata: { upstream: 'streams-service' } },
    )
    expect(readGatewayMetadata(routeOptions)).toEqual({ upstream: 'streams-service' })
  })

  it('stamps metadata on dual-mode routes', () => {
    const routeOptions = buildApiRoute(
      dualModeContract,
      (_request, _reply, { expectedContentType, sse }) => {
        if (expectedContentType === 'text/event-stream') {
          sse.start('autoClose')
          return
        }
        return { status: 200, contentType: 'application/json', body: { id: '1', name: 'Alice' } }
      },
      { gatewayMetadata: { tags: ['chat'] } },
    )
    expect(readGatewayMetadata(routeOptions)).toEqual({ tags: ['chat'] })
  })

  it('narrows match.query keys to the contract requestQuerySchema', () => {
    const routeOptions = buildApiRoute(
      queryAwareContract,
      async () => ({ status: 200, body: { id: '1', name: 'Alice' } }),
      {
        gatewayMetadata: {
          match: { query: { q: { prefix: 'foo' }, limit: { exact: '10' } } },
        },
      },
    )
    expect(readGatewayMetadata(routeOptions)?.match?.query).toEqual({
      q: { prefix: 'foo' },
      limit: { exact: '10' },
    })
  })

  it('coexists with passthrough Fastify options like preHandler', () => {
    const preHandler = vi.fn()
    const routeOptions = buildApiRoute(
      headerAwareContract,
      async () => ({ status: 200, body: { id: '1', name: 'Alice' } }),
      {
        preHandler,
        gatewayMetadata: { upstream: 'tenants-service' },
      },
    )
    // preHandler reaches Fastify (own enumerable), gatewayMetadata reaches the symbol.
    expect(routeOptions.preHandler).toBe(preHandler)
    expect((routeOptions as { gatewayMetadata?: unknown }).gatewayMetadata).toBeUndefined()
    expect(readGatewayMetadata(routeOptions)).toEqual({ upstream: 'tenants-service' })
  })

  it('rejects header keys not declared on the contract at compile time', () => {
    buildApiRoute(
      headerAwareContract,
      async () => ({ status: 200, body: { id: '1', name: 'Alice' } }),
      {
        gatewayMetadata: {
          match: {
            headers: {
              'x-trace-id': { regex: '^[a-f0-9]+$' },
              // @ts-expect-error 'x-not-on-contract' is not in requestHeaderSchema
              'x-not-on-contract': 'foo',
            },
          },
        },
      },
    )
  })

  it('rejects rateLimit.key.header values not declared on the contract at compile time', () => {
    buildApiRoute(
      headerAwareContract,
      async () => ({ status: 200, body: { id: '1', name: 'Alice' } }),
      {
        gatewayMetadata: {
          // @ts-expect-error 'x-not-on-contract' is not in requestHeaderSchema
          rateLimit: { requests: 10, per: '1s', key: { header: 'x-not-on-contract' } },
        },
      },
    )
  })

  it('rejects query keys not declared on the contract at compile time', () => {
    buildApiRoute(
      queryAwareContract,
      async () => ({ status: 200, body: { id: '1', name: 'Alice' } }),
      {
        gatewayMetadata: {
          match: {
            query: {
              q: { prefix: 'foo' },
              // @ts-expect-error 'unknown' is not in requestQuerySchema
              unknown: 'bar',
            },
          },
        },
      },
    )
  })

  it('a later withGatewayMetadata call overwrites inline gatewayMetadata (no merge)', () => {
    const route = buildApiRoute(
      headerAwareContract,
      async () => ({ status: 200, body: { id: '1', name: 'Alice' } }),
      { gatewayMetadata: { upstream: 'inline-svc', cache: { ttl: '60s' } } },
    )
    withGatewayMetadata(headerAwareContract, route, { upstream: 'override-svc' })
    // Documented "later call wins" semantic — `cache` is gone, not merged.
    expect(readGatewayMetadata(route)).toEqual({ upstream: 'override-svc' })
  })
})
