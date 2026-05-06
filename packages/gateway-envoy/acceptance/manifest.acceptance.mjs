/**
 * Acceptance manifest. Hand-written rather than collected from a real
 * DIContext to keep this self-contained — we want to verify the generator
 * under conditions we control, not the full pipeline.
 *
 * @type {import('opinionated-machine').GatewayManifest}
 */
export const acceptanceManifest = {
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
