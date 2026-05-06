import { describe, expect, it } from 'vitest'
import { fixtureManifest } from './__fixtures__/manifest.fixture.ts'
import { renderKongConfig } from './render.ts'

describe('renderKongConfig', () => {
  const options = {
    upstreams: { 'users-service': { url: 'http://users:8081' } },
  }

  it('matches the YAML snapshot for the fixture manifest', () => {
    const { yaml } = renderKongConfig(fixtureManifest, options)
    expect(yaml).toMatchSnapshot()
  })

  it('matches the JSON snapshot for the fixture manifest', () => {
    const { json } = renderKongConfig(fixtureManifest, options)
    expect(json).toMatchSnapshot()
  })

  it('emits one Kong service per upstream, with all routes nested under it', () => {
    const { json } = renderKongConfig(fixtureManifest, options)
    expect(json.services).toHaveLength(1)
    expect(json.services[0]?.name).toBe('users-service')
    expect(json.services[0]?.routes.map((r) => r.name).sort()).toEqual([
      'usersController.createItem',
      'usersController.deleteItem',
      'usersController.getItem',
    ])
  })

  it('converts {param} segments to Kong regex paths with named captures', () => {
    const { json } = renderKongConfig(fixtureManifest, options)
    const getItem = json.services[0]?.routes.find((r) => r.name === 'usersController.getItem')
    expect(getItem?.paths).toEqual(['~/users/(?<userId>[^/]+)$'])
  })

  it('attaches a rate-limiting plugin for routes that declare metadata.rateLimit', () => {
    const { json } = renderKongConfig(fixtureManifest, options)
    const createItem = json.services[0]?.routes.find((r) => r.name === 'usersController.createItem')
    const rl = createItem?.plugins?.find((p) => p.name === 'rate-limiting')
    expect(rl?.config).toMatchObject({ minute: 10, limit_by: 'ip' })
  })

  it('attaches a proxy-cache plugin for routes that declare metadata.cache', () => {
    const { json } = renderKongConfig(fixtureManifest, options)
    const getItem = json.services[0]?.routes.find((r) => r.name === 'usersController.getItem')
    const cache = getItem?.plugins?.find((p) => p.name === 'proxy-cache')
    expect(cache?.config).toMatchObject({ cache_ttl: 60, request_method: ['GET'] })
  })

  it('promotes the first route-level CORS block to a global Kong plugin', () => {
    const { json } = renderKongConfig(fixtureManifest, options)
    expect(json.plugins.find((p) => p.name === 'cors')?.config).toMatchObject({
      origins: ['https://app.example.com'],
      credentials: true,
    })
  })

  it('propagates header transformations as request-/response-transformer plugins', () => {
    const { json } = renderKongConfig(fixtureManifest, options)
    const createItem = json.services[0]?.routes.find((r) => r.name === 'usersController.createItem')
    const reqTransformer = createItem?.plugins?.find((p) => p.name === 'request-transformer')
    expect(reqTransformer?.config).toMatchObject({
      add: { headers: ['x-internal:true'] },
      remove: { headers: ['cookie'] },
    })
  })

  it('reports unsupported metadata fields as warnings', () => {
    const { warnings } = renderKongConfig(fixtureManifest, options)
    expect(warnings.some((w) => w.includes('circuitBreaker'))).toBe(true)
  })

  it('throws when an upstream is referenced but no URL is configured', () => {
    expect(() => renderKongConfig(fixtureManifest, { upstreams: {} })).toThrow(
      /upstream "users-service"/,
    )
  })

  it('reads service-level read_timeout from the LOOSEST route timeout in that upstream', () => {
    // Kong CE has no per-route timeout override; using the loosest avoids
    // silently shortening timeouts on routes that asked for more.
    const { json } = renderKongConfig(fixtureManifest, options)
    // Loosest among 5s / 2s / (no timeout) is 5s = 5000ms.
    expect(json.services[0]?.read_timeout).toBe(5000)
  })

  it('warns when a route asked for a tighter timeout than the service-level one allows', () => {
    const { warnings } = renderKongConfig(fixtureManifest, options)
    // The 2s route is tighter than the service-level 5s read_timeout.
    expect(
      warnings.some(
        (w) =>
          w.includes('usersController.getItem') &&
          w.includes('tighter') &&
          w.includes('per-route timeout override'),
      ),
    ).toBe(true)
  })

  describe('profile: enterprise', () => {
    const mtlsManifest: typeof fixtureManifest = {
      ...fixtureManifest,
      routes: [
        {
          id: 'secure.get',
          method: 'GET',
          path: '/secure',
          controller: 'secure',
          routeKey: 'get',
          metadata: { upstream: 'users-service', auth: { mTLS: true, required: true } },
        },
      ],
    }

    it('emits the mtls-auth plugin for auth.mTLS routes (no warning)', () => {
      const { json, warnings } = renderKongConfig(mtlsManifest, {
        ...options,
        profile: 'enterprise',
      })
      const route = json.services[0]?.routes[0]
      expect(route?.plugins?.some((p) => p.name === 'mtls-auth')).toBe(true)
      expect(warnings.some((w) => w.includes('auth.mTLS'))).toBe(false)
    })

    it('warns instead of emitting mtls-auth under the OSS profile', () => {
      const { json, warnings } = renderKongConfig(mtlsManifest, options) // profile defaults to 'oss'
      const route = json.services[0]?.routes[0]
      expect(route?.plugins?.some((p) => p.name === 'mtls-auth') ?? false).toBe(false)
      expect(warnings.some((w) => w.includes('auth.mTLS') && w.includes('Enterprise'))).toBe(true)
    })
  })
})
