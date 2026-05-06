import { buildRestContract } from '@lokalise/api-contracts'
import { buildFastifyRoute } from '@lokalise/fastify-api-contracts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod/v4'
import { GATEWAY_METADATA_SYMBOL } from './gatewaySymbol.ts'
import { readGatewayMetadata, withGatewayMetadata } from './withGatewayMetadata.ts'

const headerAwareContract = buildRestContract({
  method: 'post',
  successResponseBodySchema: z.object({ ok: z.boolean() }),
  requestBodySchema: z.object({ name: z.string() }),
  requestPathParamsSchema: z.object({ tenantId: z.string() }),
  requestHeaderSchema: z.object({ 'x-trace-id': z.string() }),
  pathResolver: (p) => `/tenants/${p.tenantId}/items`,
})

describe('withGatewayMetadata', () => {
  it('returns the same route reference (no copy)', () => {
    const route = buildFastifyRoute(headerAwareContract, async (_, reply) => {
      await reply.status(200).send({ ok: true })
    })
    const annotated = withGatewayMetadata(headerAwareContract, route, {
      cache: { ttl: '60s' },
    })
    expect(annotated).toBe(route)
  })

  it('attaches metadata via a non-enumerable symbol (invisible to Fastify and JSON)', () => {
    const route = buildFastifyRoute(headerAwareContract, async (_, reply) => {
      await reply.status(200).send({ ok: true })
    })
    withGatewayMetadata(headerAwareContract, route, { upstream: 'svc' })

    expect(Object.keys(route)).not.toContain(GATEWAY_METADATA_SYMBOL.toString())
    expect(JSON.stringify(route)).not.toContain('upstream')
    expect(Object.getOwnPropertyDescriptor(route, GATEWAY_METADATA_SYMBOL)?.enumerable).toBe(false)
  })

  it('readGatewayMetadata returns the stamped metadata', () => {
    const route = buildFastifyRoute(headerAwareContract, async (_, reply) => {
      await reply.status(200).send({ ok: true })
    })
    withGatewayMetadata(headerAwareContract, route, {
      upstream: 'tenants-service',
      cache: { ttl: '30s' },
    })
    expect(readGatewayMetadata(route)).toEqual({
      upstream: 'tenants-service',
      cache: { ttl: '30s' },
    })
  })

  it('readGatewayMetadata returns undefined for un-annotated routes', () => {
    const route = buildFastifyRoute(headerAwareContract, async (_, reply) => {
      await reply.status(200).send({ ok: true })
    })
    expect(readGatewayMetadata(route)).toBeUndefined()
  })

  it('accepts contract-typed match.headers keys (typecheck-driven)', () => {
    const route = buildFastifyRoute(headerAwareContract, async (_, reply) => {
      await reply.status(200).send({ ok: true })
    })
    // The 'x-trace-id' key is type-checked against requestHeaderSchema.
    const annotated = withGatewayMetadata(headerAwareContract, route, {
      match: { headers: { 'x-trace-id': { regex: '^[a-f0-9]+$' } } },
    })
    expect(readGatewayMetadata(annotated)?.match?.headers?.['x-trace-id']).toEqual({
      regex: '^[a-f0-9]+$',
    })
  })

  it('customHeaders accepts free-form keys for headers not in the contract', () => {
    const route = buildFastifyRoute(headerAwareContract, async (_, reply) => {
      await reply.status(200).send({ ok: true })
    })
    const annotated = withGatewayMetadata(headerAwareContract, route, {
      match: { customHeaders: { 'x-cf-tenant': 'enterprise' } },
    })
    expect(readGatewayMetadata(annotated)?.match?.customHeaders).toEqual({
      'x-cf-tenant': 'enterprise',
    })
  })
})
