import { describe, expect, it } from 'vitest'
import { fixtureManifest } from './__fixtures__/manifest.fixture.ts'
import { renderEnvoyConfig } from './render.ts'

const findRoute = (json: ReturnType<typeof renderEnvoyConfig>['json'], name: string) => {
  const typedConfig = json.static_resources.listeners[0]?.filter_chains[0]?.filters[0]
    ?.typed_config as {
    route_config: { virtual_hosts: Array<{ routes: Array<Record<string, unknown>> }> }
  }
  return typedConfig.route_config.virtual_hosts[0]?.routes.find((r) => r.name === name)
}

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
    it('disables route timeout and idle timeout for streaming routes without declared timeouts', () => {
      const { json } = renderEnvoyConfig(fixtureManifest, options)
      // Envoy defaults (15s route timeout, 5m stream idle) would reset streams.
      expect(findRoute(json, 'notificationsController.stream')?.route).toEqual({
        cluster: 'users-service',
        timeout: '0s',
        idle_timeout: '0s',
        // Both liveness bounds are off, so the lifetime ceiling is what keeps
        // the connection (and the authorization it was opened with) finite.
        max_stream_duration: { max_stream_duration: '1800s' },
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
        max_stream_duration: { max_stream_duration: '1800s' },
      })
    })

    it('splits a dual-mode route so the JSON poll branch keeps a route timeout', () => {
      const { json } = renderEnvoyConfig(fixtureManifest, options)

      const streamBranch = findRoute(json, 'jobsController.status__sse')
      const jsonBranch = findRoute(json, 'jobsController.status')

      // The stream branch is selected by the same predicate the server uses:
      // the client asks for the stream, and does not refuse it with q=0.
      expect((streamBranch?.match as { headers: unknown[] }).headers).toContainEqual({
        name: 'accept',
        string_match: { contains: 'text/event-stream' },
      })
      expect((streamBranch?.match as { headers: unknown[] }).headers).toContainEqual(
        expect.objectContaining({ name: 'accept', invert_match: true }),
      )
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
        max_stream_duration: { max_stream_duration: '1800s' },
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

describe('renderEnvoyConfig — Accept negotiation on dual routes', () => {
  const options = {
    listenPort: 8080,
    clusters: { 'users-service': { hosts: ['users:3000'] } },
  }

  function dualManifest(overrides?: Record<string, unknown>) {
    const dualRoute = fixtureManifest.routes.find(
      (r) => r.id === 'jobsController.status',
    ) as (typeof fixtureManifest.routes)[number]
    return {
      ...fixtureManifest,
      routes: [{ ...dualRoute, metadata: { upstream: 'users-service' }, ...overrides }],
    }
  }

  /** Apply the emitted Accept matchers to a header value, the way Envoy would. */
  function matchesBranch(route: Record<string, unknown> | undefined, accept?: string): boolean {
    const headers = (route?.match as { headers?: Array<Record<string, unknown>> }).headers ?? []
    return headers
      .filter((h) => h.name === 'accept')
      .every((h) => {
        const stringMatch = h.string_match as { contains?: string; safe_regex?: { regex: string } }
        const value = accept ?? ''
        const matched =
          stringMatch.contains !== undefined
            ? value.includes(stringMatch.contains)
            : new RegExp(`^${(stringMatch.safe_regex as { regex: string }).regex}$`).test(value)
        return h.invert_match === true ? !matched : matched
      })
  }

  it('does not route an Accept that refuses the stream with q=0 to the stream branch', () => {
    const { json } = renderEnvoyConfig(dualManifest(), options)
    const streamBranch = findRoute(json, 'jobsController.status__sse')

    expect(matchesBranch(streamBranch, 'text/event-stream;q=0')).toBe(false)
    expect(matchesBranch(streamBranch, 'application/json, text/event-stream;q=0')).toBe(false)
    expect(matchesBranch(streamBranch, 'text/event-stream; q=0.0')).toBe(false)
  })

  it('still routes a deprioritized but accepted stream to the stream branch', () => {
    const { json } = renderEnvoyConfig(dualManifest(), options)
    const streamBranch = findRoute(json, 'jobsController.status__sse')

    expect(matchesBranch(streamBranch, 'text/event-stream')).toBe(true)
    expect(matchesBranch(streamBranch, 'text/event-stream;q=0.5')).toBe(true)
    expect(matchesBranch(streamBranch, 'application/json;q=0.9, text/event-stream;q=0.1')).toBe(
      true,
    )
  })

  it.each([
    ['a missing Accept header', undefined],
    ['a wildcard Accept header', '*/*'],
    ['an explicit application/json Accept header', 'application/json'],
  ])('sends %s to the plain branch with defaultMode json', (_label, accept) => {
    const { json } = renderEnvoyConfig(dualManifest(), options)

    expect(matchesBranch(findRoute(json, 'jobsController.status__sse'), accept)).toBe(false)
    // The catch-all carries no Accept matcher, so it takes everything else.
    expect(matchesBranch(findRoute(json, 'jobsController.status'), accept)).toBe(true)
  })

  it('makes the stream the catch-all when the route declares defaultMode sse', () => {
    const { json, warnings } = renderEnvoyConfig(
      dualManifest({ streamingDefaultMode: 'sse' }),
      options,
    )
    const jsonBranch = findRoute(json, 'jobsController.status__json')
    const streamBranch = findRoute(json, 'jobsController.status__sse')

    // A missing or wildcard Accept header streams on the server, so it must
    // reach the stream-shaped branch here rather than the request timeout.
    expect(matchesBranch(jsonBranch, undefined)).toBe(false)
    expect(matchesBranch(jsonBranch, '*/*')).toBe(false)
    expect(matchesBranch(jsonBranch, 'application/json')).toBe(true)
    expect(streamBranch?.route).toMatchObject({ timeout: '0s' })
    expect(warnings.some((w) => w.includes('defaultMode "sse"'))).toBe(true)
  })

  it('sends a JSON request that refuses the stream to a plain branch with defaultMode sse', () => {
    const { json } = renderEnvoyConfig(dualManifest({ streamingDefaultMode: 'sse' }), options)
    const refusedBranch = findRoute(json, 'jobsController.status__json_sse_refused')

    // determineMode() filters q=0 out before ranking, so this resolves to JSON
    // on the server; the plain JSON branch's `contains` exclusion cannot match
    // it, and without this route it fell through to the stream catch-all.
    const jsonBranch = findRoute(json, 'jobsController.status__json')
    expect(matchesBranch(jsonBranch, 'application/json, text/event-stream;q=0')).toBe(false)
    expect(matchesBranch(refusedBranch, 'application/json, text/event-stream;q=0')).toBe(true)
    // Same plain-branch route action as the ordinary JSON branch: no disabled
    // route timeout, no stream-duration ceiling.
    expect(refusedBranch?.route).toEqual(jsonBranch?.route)

    // It stays narrow: an accepted stream, and a refusal without a JSON ask,
    // both keep the catch-all.
    expect(matchesBranch(refusedBranch, 'application/json, text/event-stream')).toBe(false)
    expect(matchesBranch(refusedBranch, 'text/event-stream;q=0')).toBe(false)
  })

  it('orders both json branches before the stream catch-all with defaultMode sse', () => {
    const { json } = renderEnvoyConfig(dualManifest({ streamingDefaultMode: 'sse' }), options)
    const typedConfig = json.static_resources.listeners[0]?.filter_chains[0]?.filters[0]
      ?.typed_config as {
      route_config: { virtual_hosts: Array<{ routes: Array<Record<string, unknown>> }> }
    }
    const names = typedConfig.route_config.virtual_hosts[0]?.routes.map((r) => r.name) ?? []

    expect(names.indexOf('jobsController.status__json')).toBeLessThan(
      names.indexOf('jobsController.status__sse'),
    )
    expect(names.indexOf('jobsController.status__json_sse_refused')).toBeLessThan(
      names.indexOf('jobsController.status__sse'),
    )
  })
})

describe('renderEnvoyConfig — bounded stream lifetime', () => {
  const options = {
    listenPort: 8080,
    clusters: { 'users-service': { hosts: ['users:3000'] } },
  }

  it('honours EnvoyOptions.maxStreamDuration', () => {
    const { json } = renderEnvoyConfig(fixtureManifest, { ...options, maxStreamDuration: '10m' })

    expect(findRoute(json, 'notificationsController.stream')?.route).toMatchObject({
      max_stream_duration: { max_stream_duration: '600s' },
    })
  })

  it('lets a route override the ceiling with timeouts.maxDuration', () => {
    const manifest = {
      ...fixtureManifest,
      routes: [
        {
          ...(fixtureManifest.routes.find(
            (r) => r.id === 'notificationsController.stream',
          ) as (typeof fixtureManifest.routes)[number]),
          metadata: { upstream: 'users-service', timeouts: { maxDuration: '2h' } },
        },
      ],
    }
    const { json } = renderEnvoyConfig(manifest, options)

    expect(findRoute(json, 'notificationsController.stream')?.route).toMatchObject({
      max_stream_duration: { max_stream_duration: '7200s' },
    })
  })

  it.each([
    ['the global opt-out', { maxStreamDuration: 'off' as const }],
    ['a zero global value', { maxStreamDuration: '0s' }],
  ])('emits no ceiling for %s', (_label, overrides) => {
    const { json } = renderEnvoyConfig(fixtureManifest, { ...options, ...overrides })
    const route = findRoute(json, 'notificationsController.stream')?.route as Record<
      string,
      unknown
    >

    expect(route.max_stream_duration).toBeUndefined()
  })

  it('emits no ceiling for a route that opts out with maxDuration 0s', () => {
    const manifest = {
      ...fixtureManifest,
      routes: [
        {
          ...(fixtureManifest.routes.find(
            (r) => r.id === 'notificationsController.stream',
          ) as (typeof fixtureManifest.routes)[number]),
          metadata: { upstream: 'users-service', timeouts: { maxDuration: '0s' } },
        },
      ],
    }
    const { json } = renderEnvoyConfig(manifest, options)
    const route = findRoute(json, 'notificationsController.stream')?.route as Record<
      string,
      unknown
    >

    expect(route.max_stream_duration).toBeUndefined()
  })

  it('does not bound plain routes', () => {
    const { json } = renderEnvoyConfig(fixtureManifest, options)
    const plain = findRoute(json, 'jobsController.status')?.route as Record<string, unknown>

    expect(plain.max_stream_duration).toBeUndefined()
  })
})
