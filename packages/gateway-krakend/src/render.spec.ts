import { describe, expect, it } from 'vitest'
import { fixtureManifest } from './__fixtures__/manifest.fixture.ts'
import { renderKrakendConfig } from './render.ts'

describe('renderKrakendConfig', () => {
  const options = {
    port: 8080,
    upstreams: { 'users-service': 'http://users:8081' },
  }

  it('matches the JSON snapshot for the fixture manifest', () => {
    const { json } = renderKrakendConfig(fixtureManifest, options)
    expect(json).toMatchSnapshot()
  })

  it('emits one endpoint per route in manifest order', () => {
    const { json } = renderKrakendConfig(fixtureManifest, options)
    expect(json.endpoints.map((e) => `${e.method} ${e.endpoint}`)).toEqual([
      'POST /users',
      'GET /users/{userId}',
      'GET /v2/users',
    ])
  })

  it('preserves OpenAPI {param} syntax (KrakenD native)', () => {
    const { json } = renderKrakendConfig(fixtureManifest, options)
    const getItem = json.endpoints.find((e) => e.endpoint === '/users/{userId}')
    expect(getItem).toBeDefined()
  })

  it('promotes the first route-level cors block to the global extra_config', () => {
    const { json } = renderKrakendConfig(fixtureManifest, options)
    expect(json.extra_config['security/cors']).toMatchObject({
      allow_origins: ['https://app.example.com'],
      allow_credentials: true,
    })
  })

  it('applies stripPrefix rewrites to backend url_pattern', () => {
    const { json } = renderKrakendConfig(fixtureManifest, options)
    const v2 = json.endpoints.find((e) => e.endpoint === '/v2/users')
    expect(v2?.backend[0]?.url_pattern).toBe('/users')
  })

  it('throws when an upstream is referenced but no host is configured', () => {
    expect(() => renderKrakendConfig(fixtureManifest, { port: 8080, upstreams: {} })).toThrow(
      /upstream "users-service"/,
    )
  })

  it('extensions.krakend deep-merges into endpoint extra_config', () => {
    const { json } = renderKrakendConfig(fixtureManifest, options)
    const listItems = json.endpoints.find((e) => e.endpoint === '/v2/users')
    expect(listItems?.extra_config?.['qos/http-cache']).toEqual({ ttl: '10s' })
  })
})
