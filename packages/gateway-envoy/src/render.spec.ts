import { describe, expect, it } from 'vitest'
import { fixtureManifest } from './__fixtures__/manifest.fixture.ts'
import { renderEnvoyConfig } from './render.ts'

describe('renderEnvoyConfig', () => {
  const options = {
    listenPort: 8080,
    clusters: { 'users-service': { hosts: ['users:8081'] } },
  }

  it('matches the YAML snapshot for the fixture manifest', () => {
    const { yaml } = renderEnvoyConfig(fixtureManifest, options)
    expect(yaml).toMatchSnapshot()
  })

  it('matches the JSON snapshot for the fixture manifest', () => {
    const { json } = renderEnvoyConfig(fixtureManifest, options)
    expect(json).toMatchSnapshot()
  })

  it('reports unsupported metadata fields as warnings rather than dropping silently', () => {
    const { warnings } = renderEnvoyConfig(fixtureManifest, options)
    // The fixture exercises cache (unsupported in v1) — should appear in warnings.
    expect(warnings.some((w) => w.includes('cache'))).toBe(true)
  })

  it('throws when an upstream is referenced but no hosts are configured', () => {
    expect(() => renderEnvoyConfig(fixtureManifest, { listenPort: 8080, clusters: {} })).toThrow(
      /upstream "users-service"/,
    )
  })

  it('throws when a route has no upstream', () => {
    const noUpstream = {
      ...fixtureManifest,
      routes: [
        {
          ...(fixtureManifest.routes[0] as (typeof fixtureManifest.routes)[number]),
          metadata: {},
        },
      ],
    }
    expect(() => renderEnvoyConfig(noUpstream, options)).toThrow(/has no upstream/)
  })

  it('clusters are deduplicated and sorted by name', () => {
    const { json } = renderEnvoyConfig(fixtureManifest, options)
    expect(json.static_resources.clusters.map((c) => c.name)).toEqual(['users-service'])
  })
})
