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

  it('emits no admin block by default (opt-in)', () => {
    const { json } = renderEnvoyConfig(fixtureManifest, options)
    expect(json.admin).toBeUndefined()
  })

  it('emits an admin block when options.admin is provided', () => {
    const { json } = renderEnvoyConfig(fixtureManifest, {
      ...options,
      admin: { port: 9901, accessLogPath: '/tmp/envoy-admin.log' },
    })
    expect(json.admin).toEqual({
      access_log_path: '/tmp/envoy-admin.log',
      address: { socket_address: { address: '0.0.0.0', port_value: 9901 } },
    })
  })

  describe('streaming routes', () => {
    const findRoute = (json: ReturnType<typeof renderEnvoyConfig>['json'], name: string) => {
      const typedConfig = json.static_resources.listeners[0]?.filter_chains[0]?.filters[0]
        ?.typed_config as {
        route_config: { virtual_hosts: Array<{ routes: Array<Record<string, unknown>> }> }
      }
      return typedConfig.route_config.virtual_hosts[0]?.routes.find((r) => r.name === name)
    }

    it('disables route timeout and idle timeout for streaming routes without declared timeouts', () => {
      const { json } = renderEnvoyConfig(fixtureManifest, options)
      // Envoy defaults (15s route timeout, 5m stream idle) would reset streams.
      expect(findRoute(json, 'notificationsController.stream')?.route).toEqual({
        cluster: 'users-service',
        timeout: '0s',
        idle_timeout: '0s',
      })
    })

    it('maps timeouts.idle to route idle_timeout while still disabling the route timeout', () => {
      const { json } = renderEnvoyConfig(fixtureManifest, options)
      // 'jobsController.status' is dual-mode, so its stream branch is the
      // Accept-matched route (see the dual-mode split tests below).
      expect(findRoute(json, 'jobsController.status__sse')?.route).toEqual({
        cluster: 'users-service',
        timeout: '0s',
        idle_timeout: '600s',
      })
    })

    it('splits a dual-mode route so the JSON poll branch keeps a route timeout', () => {
      const { json } = renderEnvoyConfig(fixtureManifest, options)

      const streamBranch = findRoute(json, 'jobsController.status__sse')
      const jsonBranch = findRoute(json, 'jobsController.status')

      // The stream branch is selected by the same predicate the server uses.
      expect((streamBranch?.match as { headers: unknown[] }).headers).toContainEqual({
        name: 'accept',
        string_match: { contains: 'text/event-stream' },
      })
      // The JSON branch carries no Accept matcher, and none of the stream's
      // timeouts: it is an ordinary request under Envoy's own defaults.
      expect((jsonBranch?.match as { headers: unknown[] }).headers).not.toContainEqual({
        name: 'accept',
        string_match: { contains: 'text/event-stream' },
      })
      expect(jsonBranch?.route).toEqual({ cluster: 'users-service' })
    })

    it('orders the dual-mode stream branch before the catch-all branch', () => {
      const { json } = renderEnvoyConfig(fixtureManifest, options)
      const typedConfig = json.static_resources.listeners[0]?.filter_chains[0]?.filters[0]
        ?.typed_config as {
        route_config: { virtual_hosts: Array<{ routes: Array<Record<string, unknown>> }> }
      }
      const names = typedConfig.route_config.virtual_hosts[0]?.routes.map((r) => r.name) ?? []

      // Envoy takes the first match, so the narrower branch has to come first.
      expect(names.indexOf('jobsController.status__sse')).toBeLessThan(
        names.indexOf('jobsController.status'),
      )
    })

    it('bounds the JSON branch of a dual-mode route with timeouts.request', () => {
      const manifest = {
        ...fixtureManifest,
        routes: [
          {
            ...(fixtureManifest.routes.find(
              (r) => r.id === 'jobsController.status',
            ) as (typeof fixtureManifest.routes)[number]),
            metadata: { upstream: 'users-service', timeouts: { request: '5s', idle: '10m' } },
          },
        ],
      }
      const { json } = renderEnvoyConfig(manifest, options)

      // The request timeout lands on the JSON branch only...
      expect(findRoute(json, 'jobsController.status')?.route).toEqual({
        cluster: 'users-service',
        timeout: '5s',
      })
      // ...and the idle window on the stream branch only, so neither bound
      // leaks onto the exchange it was not written for.
      expect(findRoute(json, 'jobsController.status__sse')?.route).toEqual({
        cluster: 'users-service',
        timeout: '0s',
        idle_timeout: '600s',
      })
    })

    it('does not warn about timeouts.request on a dual route (it bounds the JSON branch)', () => {
      const manifest = {
        ...fixtureManifest,
        routes: [
          {
            ...(fixtureManifest.routes.find(
              (r) => r.id === 'jobsController.status',
            ) as (typeof fixtureManifest.routes)[number]),
            metadata: { upstream: 'users-service', timeouts: { request: '5s', idle: '10m' } },
          },
        ],
      }
      const { warnings } = renderEnvoyConfig(manifest, options)
      expect(warnings.some((w) => w.includes('TOTAL lifetime'))).toBe(false)
    })

    it('does not split SSE-only routes', () => {
      const { json } = renderEnvoyConfig(fixtureManifest, options)
      expect(findRoute(json, 'notificationsController.stream__sse')).toBeUndefined()
    })

    it('maps timeouts.idle on non-streaming routes too', () => {
      const manifest = {
        ...fixtureManifest,
        routes: [
          {
            ...(fixtureManifest.routes[0] as (typeof fixtureManifest.routes)[number]),
            metadata: { upstream: 'users-service', timeouts: { request: '5s', idle: '30s' } },
          },
        ],
      }
      const { json } = renderEnvoyConfig(manifest, options)
      const route = findRoute(json, fixtureManifest.routes[0]?.id as string)
      expect(route?.route).toMatchObject({ timeout: '5s', idle_timeout: '30s' })
    })

    it('warns when a streaming route declares timeouts.request (bounds stream lifetime)', () => {
      const manifest = {
        ...fixtureManifest,
        routes: [
          {
            ...(fixtureManifest.routes.find(
              (r) => r.id === 'notificationsController.stream',
            ) as (typeof fixtureManifest.routes)[number]),
            metadata: { upstream: 'users-service', timeouts: { request: '30s' } },
          },
        ],
      }
      const { warnings } = renderEnvoyConfig(manifest, options)
      expect(
        warnings.some(
          (w) => w.includes('notificationsController.stream') && w.includes('TOTAL lifetime'),
        ),
      ).toBe(true)
    })

    it('emits HCM stream_idle_timeout when options.streamIdleTimeout is set', () => {
      const { json } = renderEnvoyConfig(fixtureManifest, {
        ...options,
        streamIdleTimeout: '10m',
      })
      const typedConfig = json.static_resources.listeners[0]?.filter_chains[0]?.filters[0]
        ?.typed_config as Record<string, unknown>
      expect(typedConfig.stream_idle_timeout).toBe('600s')
    })
  })
})
