import { defineApiContract, sseBody } from '@lokalise/api-contracts'
import type { RouteOptions } from 'fastify'
import { describe, expect, it } from 'vitest'
import { z } from 'zod/v4'
import { AbstractApiController } from '../../api-contracts/AbstractApiController.ts'
import { buildApiRoute } from '../../api-contracts/apiRouteBuilder.ts'
import type { GatewayMetadataValue } from '../gatewayMetadata.ts'
import { GATEWAY_METADATA_SYMBOL } from '../gatewaySymbol.ts'
import { withGatewayMetadata } from '../withGatewayMetadata.ts'
import { buildGatewayManifestFrom, type CollectedController } from './buildManifest.ts'

const getContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Get user',
  requestPathParamsSchema: z.object({ userId: z.string() }),
  requestHeaderSchema: z.object({ 'x-trace-id': z.string() }),
  pathResolver: (p) => `/users/${p.userId}`,
  responsesByStatusCode: { 200: z.object({ ok: z.boolean() }) },
})

const createContract = defineApiContract({
  visibility: 'public',
  method: 'post',
  summary: 'Create user',
  requestBodySchema: z.object({ name: z.string() }),
  pathResolver: () => '/users',
  responsesByStatusCode: { 200: z.object({ ok: z.boolean() }) },
})

class TestUsersController extends AbstractApiController<typeof TestUsersController.contracts> {
  public static contracts = { getItem: getContract, createItem: createContract } as const

  public override readonly gatewayDefaults: GatewayMetadataValue = {
    upstream: 'users-service',
    timeouts: { request: '5s' },
    tags: ['users'],
  }

  readonly routes = {
    getItem: withGatewayMetadata(
      TestUsersController.contracts.getItem,
      buildApiRoute(TestUsersController.contracts.getItem, () => ({
        status: 200,
        body: { ok: true },
      })),
      {
        cache: { ttl: '60s' },
        match: { headers: { 'x-trace-id': { regex: '^[a-f0-9]+$' } } },
        tags: ['users', 'cacheable'],
      },
    ),
    createItem: buildApiRoute(TestUsersController.contracts.createItem, () => ({
      status: 200,
      body: { ok: true },
    })),
  }
}

function collected(): CollectedController[] {
  return [{ name: 'usersController', controller: new TestUsersController() }]
}

describe('buildGatewayManifestFrom', () => {
  it('emits one entry per route, sorted by path then method', () => {
    const manifest = buildGatewayManifestFrom(collected(), { service: 'users-api' })
    expect(manifest.service).toBe('users-api')
    expect(manifest.manifestVersion).toBe('1')
    expect(manifest.routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /users',
      'GET /users/{userId}',
    ])
  })

  it('attributes routes to the controller dependency name and route key', () => {
    const manifest = buildGatewayManifestFrom(collected(), { service: 'users-api' })
    const getItem = manifest.routes.find((r) => r.routeKey === 'getItem')
    expect(getItem).toMatchObject({
      controller: 'usersController',
      routeKey: 'getItem',
      id: 'usersController.getItem',
    })
  })

  it('merges service → controller → route metadata in order', () => {
    const manifest = buildGatewayManifestFrom(collected(), {
      service: 'users-api',
      defaults: {
        timeouts: { idle: '60s' },
        cors: { origins: ['https://app.example.com'] },
      },
    })
    const getItem = manifest.routes.find((r) => r.routeKey === 'getItem')
    expect(getItem?.metadata).toMatchObject({
      // From service defaults
      cors: { origins: ['https://app.example.com'] },
      // From controller defaults
      upstream: 'users-service',
      // From route metadata
      cache: { ttl: '60s' },
      match: { headers: { 'x-trace-id': { regex: '^[a-f0-9]+$' } } },
      // Deep-merged: service idle + controller request
      timeouts: { idle: '60s', request: '5s' },
    })
  })

  it('replaces (does not append) arrays when later layers redeclare them', () => {
    const manifest = buildGatewayManifestFrom(collected(), { service: 'users-api' })
    const getItem = manifest.routes.find((r) => r.routeKey === 'getItem')
    // Route-level tags ['users','cacheable'] replace controller-level ['users']
    expect(getItem?.metadata.tags).toEqual(['users', 'cacheable'])
  })

  it('un-annotated routes still appear and inherit defaults', () => {
    const manifest = buildGatewayManifestFrom(collected(), { service: 'users-api' })
    const createItem = manifest.routes.find((r) => r.routeKey === 'createItem')
    expect(createItem?.metadata).toMatchObject({
      upstream: 'users-service',
      timeouts: { request: '5s' },
    })
    expect(createItem?.metadata.cache).toBeUndefined()
  })

  it('reads inline gatewayMetadata passed via buildApiRoute options', () => {
    const apiGetUserContract = defineApiContract({
      visibility: 'public',
      method: 'get',
      summary: 'Api get user',
      pathResolver: (p: { userId: string }) => `/api/users/${p.userId}`,
      requestPathParamsSchema: z.object({ userId: z.string() }),
      requestHeaderSchema: z.object({ 'x-trace-id': z.string() }),
      responsesByStatusCode: { 200: z.object({ id: z.string() }) },
    })
    const apiCreateUserContract = defineApiContract({
      visibility: 'public',
      method: 'post',
      summary: 'Api create user',
      pathResolver: () => '/api/users',
      requestBodySchema: z.object({ name: z.string() }),
      responsesByStatusCode: { 201: z.object({ id: z.string() }) },
    })

    class InlineApiController extends AbstractApiController<typeof InlineApiController.contracts> {
      static contracts = {
        getItem: apiGetUserContract,
        createItem: apiCreateUserContract,
      } as const

      public override readonly gatewayDefaults: GatewayMetadataValue = {
        upstream: 'users-service',
        timeouts: { request: '5s' },
      }

      readonly routes: Record<keyof typeof InlineApiController.contracts, RouteOptions> = {
        getItem: buildApiRoute(
          InlineApiController.contracts.getItem,
          async () => ({ status: 200, body: { id: '1' } }),
          {
            gatewayMetadata: {
              cache: { ttl: '60s' },
              match: { headers: { 'x-trace-id': { regex: '^[a-f0-9]+$' } } },
              tags: ['users', 'cacheable'],
            },
          },
        ),
        createItem: buildApiRoute(InlineApiController.contracts.createItem, async (req) => ({
          status: 201,
          body: { id: req.body.name },
        })),
      }
    }

    const manifest = buildGatewayManifestFrom(
      [{ name: 'inlineApi', controller: new InlineApiController() }],
      { service: 'users-api' },
    )
    const getItem = manifest.routes.find((r) => r.routeKey === 'getItem')
    expect(getItem?.metadata).toMatchObject({
      // From controller defaults
      upstream: 'users-service',
      timeouts: { request: '5s' },
      // From inline route metadata
      cache: { ttl: '60s' },
      match: { headers: { 'x-trace-id': { regex: '^[a-f0-9]+$' } } },
      tags: ['users', 'cacheable'],
    })
    const createItem = manifest.routes.find((r) => r.routeKey === 'createItem')
    expect(createItem?.metadata.cache).toBeUndefined()
    expect(createItem?.metadata).toMatchObject({ upstream: 'users-service' })
  })

  it('rejects invalid metadata at the manifest boundary', () => {
    class BadController extends AbstractApiController<{ x: typeof getContract }> {
      readonly routes = {
        x: buildApiRoute(getContract, () => ({ status: 200, body: { ok: true } })),
      }
    }
    const controller = new BadController()
    // Bypass the eager validation in withGatewayMetadata to exercise the manifest boundary:
    // an invalid duration "5seconds" must still be rejected there.
    Object.defineProperty(controller.routes.x, GATEWAY_METADATA_SYMBOL, {
      value: { timeouts: { request: '5seconds' } },
      enumerable: false,
    })
    const list: CollectedController[] = [{ name: 'bad', controller }]
    expect(() => buildGatewayManifestFrom(list, { service: 'svc' })).toThrow()
  })
})

// ============================================================================
// Streaming marker
// ============================================================================

const apiSseOnlyContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'stream',
  pathResolver: () => '/stream',
  responsesByStatusCode: {
    200: { content: { 'text/event-stream': sseBody({ tick: z.object({ n: z.number() }) }) } },
  },
})

const apiDualContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'dual',
  pathResolver: () => '/dual',
  responsesByStatusCode: {
    200: {
      content: {
        'application/json': z.object({ ok: z.boolean() }),
        'text/event-stream': sseBody({ tick: z.object({ n: z.number() }) }),
      },
    },
  },
})

const apiPlainContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'plain',
  pathResolver: () => '/plain',
  responsesByStatusCode: { 200: z.object({ ok: z.boolean() }) },
})

class StreamingApiController extends AbstractApiController<{
  stream: typeof apiSseOnlyContract
  dual: typeof apiDualContract
  plain: typeof apiPlainContract
}> {
  readonly routes = {
    stream: buildApiRoute(apiSseOnlyContract, (_request, _reply, { sse }) => {
      sse.start('keepAlive')
    }),
    dual: buildApiRoute(apiDualContract, (_request, _reply, { expectedContentType, sse }) => {
      if (expectedContentType === 'text/event-stream') {
        sse.start('autoClose')
        return
      }
      return { status: 200, contentType: 'application/json', body: { ok: true } }
    }),
    plain: buildApiRoute(apiPlainContract, () => ({ status: 200, body: { ok: true } })),
  }
}

describe('buildGatewayManifestFrom — streaming marker', () => {
  it('marks api-contract SSE and dual routes, leaves plain routes unmarked', () => {
    const manifest = buildGatewayManifestFrom(
      [{ name: 'streamingController', controller: new StreamingApiController() }],
      { service: 'svc' },
    )
    const byKey = Object.fromEntries(manifest.routes.map((r) => [r.routeKey, r]))
    expect(byKey.stream?.streaming).toBe('sse')
    expect(byKey.dual?.streaming).toBe('dual')
    expect(byKey.plain?.streaming).toBeUndefined()
    expect('streaming' in (byKey.plain ?? {})).toBe(false)
  })
})
