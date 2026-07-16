import {
  anyOfResponses,
  blobBody,
  ContractNoBody,
  defineApiContract,
  sseBody,
  sseResponse,
} from '@lokalise/api-contracts'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod/v4'
import { GATEWAY_METADATA_SYMBOL } from '../gateway/gatewaySymbol.ts'
import { readGatewayMetadata, withGatewayMetadata } from '../gateway/withGatewayMetadata.ts'
import { buildApiRoute } from './apiRouteBuilder.ts'

// ============================================================================
// Shared test fixtures
// ============================================================================

const userSchema = z.object({ id: z.string(), name: z.string() })

const getUserContract = defineApiContract({
  method: 'get',
  summary: 'Get user',
  pathResolver: (p: { userId: string }) => `/users/${p.userId}`,
  requestPathParamsSchema: z.object({ userId: z.string() }),
  responsesByStatusCode: { 200: userSchema },
})

const createUserContract = defineApiContract({
  method: 'post',
  summary: 'Create user',
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
  summary: 'Sse only',
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

// Content-map response entries (api-contracts >= 6.15) — the new `{ content: {...} }` shape.
const contentJsonContract = defineApiContract({
  method: 'get',
  summary: 'Content json',
  pathResolver: () => '/content-json',
  responsesByStatusCode: {
    200: { content: { 'application/json': userSchema } },
  },
})

const contentSseOnlyContract = defineApiContract({
  method: 'get',
  summary: 'Content sse only',
  pathResolver: () => '/content-stream',
  responsesByStatusCode: {
    200: { content: { 'text/event-stream': sseBody(sseEventsSchema) } },
  },
})

const contentDualContract = defineApiContract({
  method: 'post',
  summary: 'Content dual',
  pathResolver: () => '/content-chat',
  requestBodySchema: z.object({ message: z.string() }),
  responsesByStatusCode: {
    200: {
      content: { 'application/json': userSchema, 'text/event-stream': sseBody(sseEventsSchema) },
    },
  },
})

const contentBlobDualContract = defineApiContract({
  method: 'get',
  summary: 'Content blob dual',
  pathResolver: () => '/content-blob',
  responsesByStatusCode: {
    200: {
      content: {
        'application/octet-stream': blobBody(),
        'text/event-stream': sseBody(sseEventsSchema),
      },
    },
  },
})

const contentAllowNoBodyContract = defineApiContract({
  method: 'get',
  summary: 'Content allow no body',
  pathResolver: () => '/content-allow-no-body',
  responsesByStatusCode: {
    200: { content: { 'text/event-stream': sseBody(sseEventsSchema) }, allowNoBody: true },
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
// buildApiRoute — response schemas
// ============================================================================

describe('buildApiRoute — response schemas', () => {
  it('includes JSON response schema for a GET route', () => {
    const routeOptions = buildApiRoute(getUserContract, async () => ({
      status: 200,
      body: { id: '1', name: 'Alice' },
    }))
    expect(routeOptions).toEqual(
      expect.objectContaining({
        schema: expect.objectContaining({ response: { 200: userSchema } }),
      }),
    )
  })

  it('includes JSON response schema for a POST route', () => {
    const routeOptions = buildApiRoute(createUserContract, async () => ({
      status: 201,
      body: { id: '1', name: 'Alice' },
    }))
    expect(routeOptions).toEqual(
      expect.objectContaining({
        schema: expect.objectContaining({ response: { 201: userSchema } }),
      }),
    )
  })

  it('omits ContractNoBody status codes from response schemas', () => {
    const routeOptions = buildApiRoute(deleteUserContract, async () => ({
      status: 204,
      body: undefined,
    }))
    expect(routeOptions).toEqual(
      expect.objectContaining({ schema: expect.objectContaining({ response: {} }) }),
    )
  })

  it('omits SSE-only status codes from response schemas', () => {
    const routeOptions = buildApiRoute(sseOnlyContract, (_request, sse) => {
      sse.start('keepAlive')
    })
    expect(routeOptions).toEqual(
      expect.objectContaining({ schema: expect.objectContaining({ response: {} }) }),
    )
  })

  it('picks the JSON schema from anyOfResponses even when SSE variant comes first', () => {
    const sseFirstContract = defineApiContract({
      method: 'get',
      pathResolver: () => '/mixed',
      responsesByStatusCode: {
        200: anyOfResponses([sseResponse(sseEventsSchema), userSchema]),
      },
    })
    const routeOptions = buildApiRoute(sseFirstContract, {
      nonSse: async () => ({ status: 200, body: { id: '1', name: 'Alice' } }),
      sse: (_request, sse) => {
        sse.start('keepAlive')
      },
    })
    expect(routeOptions).toEqual(
      expect.objectContaining({
        schema: expect.objectContaining({ response: { 200: userSchema } }),
      }),
    )
  })
})

// ============================================================================
// buildApiRoute — content-map response entries (api-contracts >= 6.15)
// ============================================================================

describe('buildApiRoute — content-map response entries', () => {
  it('treats a JSON-only content entry as non-SSE', () => {
    const routeOptions = buildApiRoute(contentJsonContract, async () => ({
      status: 200,
      body: undefined,
    }))
    expect((routeOptions as { sse?: unknown }).sse).toBeUndefined()
    expect(routeOptions).toEqual(
      expect.objectContaining({
        schema: expect.objectContaining({ response: { 200: userSchema } }),
      }),
    )
  })

  it('treats an SSE-only content entry as SSE and omits its response schema', () => {
    const routeOptions = buildApiRoute(contentSseOnlyContract, (_request, sse) => {
      sse.start('keepAlive')
    })
    expect((routeOptions as { sse?: unknown }).sse).toBe(true)
    expect(routeOptions).toEqual(
      expect.objectContaining({ schema: expect.objectContaining({ response: {} }) }),
    )
  })

  it('treats a JSON + SSE content entry as dual and resolves the JSON response schema', () => {
    const routeOptions = buildApiRoute(contentDualContract, {
      nonSse: async () => ({ status: 200, body: undefined }),
      sse: (_request, sse) => {
        sse.start('autoClose')
      },
    })
    expect((routeOptions as { sse?: unknown }).sse).toBe(true)
    expect(routeOptions).toEqual(
      expect.objectContaining({
        schema: expect.objectContaining({ response: { 200: userSchema } }),
      }),
    )
  })

  it('treats a blob + SSE content entry as dual (non-JSON, non-SSE descriptor counts)', () => {
    const routeOptions = buildApiRoute(contentBlobDualContract, {
      nonSse: async () => ({ status: 200, body: undefined }),
      sse: (_request, sse) => {
        sse.start('autoClose')
      },
    })
    expect((routeOptions as { sse?: unknown }).sse).toBe(true)
    // No JSON media type is declared, so no response schema is registered.
    expect(routeOptions).toEqual(
      expect.objectContaining({ schema: expect.objectContaining({ response: {} }) }),
    )
  })

  it('treats an allowNoBody content entry as dual', () => {
    const routeOptions = buildApiRoute(contentAllowNoBodyContract, {
      nonSse: async () => ({ status: 200, body: undefined }),
      sse: (_request, sse) => {
        sse.start('autoClose')
      },
    })
    expect((routeOptions as { sse?: unknown }).sse).toBe(true)
    expect(routeOptions).toEqual(
      expect.objectContaining({ schema: expect.objectContaining({ response: {} }) }),
    )
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

// ============================================================================
// buildApiRoute — inline gatewayMetadata
// ============================================================================

const headerAwareContract = defineApiContract({
  method: 'get',
  summary: 'Header aware',
  pathResolver: (p: { tenantId: string }) => `/tenants/${p.tenantId}`,
  requestPathParamsSchema: z.object({ tenantId: z.string() }),
  requestHeaderSchema: z.object({ 'x-trace-id': z.string() }),
  responsesByStatusCode: { 200: userSchema },
})

const queryAwareContract = defineApiContract({
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

  it('attaches metadata via a non-enumerable symbol (invisible to Fastify and JSON)', () => {
    const routeOptions = buildApiRoute(
      getUserContract,
      async () => ({ status: 200, body: { id: '1', name: 'Alice' } }),
      { gatewayMetadata: { upstream: 'users-service' } },
    )
    expect(Object.keys(routeOptions)).not.toContain(GATEWAY_METADATA_SYMBOL.toString())
    expect(JSON.stringify(routeOptions)).not.toContain('users-service')
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
      (_req, sse) => {
        sse.start('keepAlive')
      },
      { gatewayMetadata: { upstream: 'streams-service' } },
    )
    expect(readGatewayMetadata(routeOptions)).toEqual({ upstream: 'streams-service' })
  })

  it('stamps metadata on dual-mode routes', () => {
    const routeOptions = buildApiRoute(
      dualModeContract,
      {
        nonSse: async () => ({ status: 200, body: { id: '1', name: 'Alice' } }),
        sse: (_req, sse) => {
          sse.start('autoClose')
        },
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
