import type { GatewayManifest } from 'opinionated-machine'

/**
 * Acceptance-test manifest. Hand-written rather than generated through
 * `DIContext.buildGatewayManifest` to keep this self-contained — we want to
 * verify the generator under conditions we control, not the full pipeline.
 */
export const acceptanceManifest: GatewayManifest = {
  manifestVersion: '1',
  service: 'gateway-envoy-acceptance',
  generatedAt: '2026-05-06T00:00:00.000Z',
  routes: [
    {
      id: 'echo.get',
      method: 'GET',
      path: '/echo',
      controller: 'echo',
      routeKey: 'get',
      metadata: {
        upstream: 'upstream',
        timeouts: { request: '2s' },
      },
    },
    {
      id: 'echo.slow',
      method: 'GET',
      path: '/slow',
      controller: 'echo',
      routeKey: 'slow',
      // Tight timeout so we can verify Envoy enforces it.
      metadata: { upstream: 'upstream', timeouts: { request: '200ms' } },
    },
  ],
}
