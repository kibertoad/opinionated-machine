import { buildRestContract, defineApiContract } from '@lokalise/api-contracts'
import { buildFastifyRoute } from '@lokalise/fastify-api-contracts'
import type { RouteOptions } from 'fastify'
import { describe, expect, it } from 'vitest'
import { z } from 'zod/v4'
import { AbstractController, type BuildRoutesReturnType } from '../../AbstractController.ts'
import { AbstractApiController } from '../../api-contracts/AbstractApiController.ts'
import { buildApiRoute } from '../../api-contracts/apiRouteBuilder.ts'
import type { GatewayMetadataValue } from '../gatewayMetadata.ts'
import { withGatewayMetadata } from '../withGatewayMetadata.ts'
import { buildGatewayManifestFrom, type CollectedController } from './buildManifest.ts'

const getContract = buildRestContract({
  method: 'get',
  successResponseBodySchema: z.object({ ok: z.boolean() }),
  requestPathParamsSchema: z.object({ userId: z.string() }),
  requestHeaderSchema: z.object({ 'x-trace-id': z.string() }),
  pathResolver: (p) => `/users/${p.userId}`,
})

const createContract = buildRestContract({
  method: 'post',
  successResponseBodySchema: z.object({ ok: z.boolean() }),
  requestBodySchema: z.object({ name: z.string() }),
  pathResolver: () => '/users',
})

class TestUsersController extends AbstractController<typeof TestUsersController.contracts> {
  public static contracts = { getItem: getContract, createItem: createContract } as const

  public override readonly gatewayDefaults: GatewayMetadataValue = {
    upstream: 'users-service',
    timeouts: { request: '5s' },
    tags: ['users'],
  }

  private getItem = buildFastifyRoute(TestUsersController.contracts.getItem, async (_, reply) => {
    await reply.status(200).send({ ok: true })
  })

  private createItem = buildFastifyRoute(
    TestUsersController.contracts.createItem,
    async (_, reply) => {
      await reply.status(200).send({ ok: true })
    },
  )

  public buildRoutes(): BuildRoutesReturnType<typeof TestUsersController.contracts> {
    return {
      getItem: withGatewayMetadata(TestUsersController.contracts.getItem, this.getItem, {
        cache: { ttl: '60s' },
        match: { headers: { 'x-trace-id': { regex: '^[a-f0-9]+$' } } },
        tags: ['users', 'cacheable'],
      }),
      createItem: this.createItem,
    }
  }
}

function collected(): CollectedController[] {
  return [{ name: 'usersController', kind: 'rest', controller: new TestUsersController() }]
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
      method: 'get',
      summary: 'Api get user',
      pathResolver: (p: { userId: string }) => `/api/users/${p.userId}`,
      requestPathParamsSchema: z.object({ userId: z.string() }),
      requestHeaderSchema: z.object({ 'x-trace-id': z.string() }),
      responsesByStatusCode: { 200: z.object({ id: z.string() }) },
    })
    const apiCreateUserContract = defineApiContract({
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
      [{ name: 'inlineApi', kind: 'api', controller: new InlineApiController() }],
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
    class BadController extends AbstractController<{ x: typeof getContract }> {
      private getItem = buildFastifyRoute(getContract, async (_, reply) => {
        await reply.status(200).send({ ok: true })
      })
      public buildRoutes(): BuildRoutesReturnType<{ x: typeof getContract }> {
        // Invalid duration "5seconds" should fail validation.
        return {
          x: withGatewayMetadata(getContract, this.getItem, {
            timeouts: { request: '5seconds' as never },
          }),
        }
      }
    }
    const list: CollectedController[] = [
      { name: 'bad', kind: 'rest', controller: new BadController() },
    ]
    expect(() => buildGatewayManifestFrom(list, { service: 'svc' })).toThrow()
  })
})
