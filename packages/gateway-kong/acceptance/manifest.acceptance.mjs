/** @type {import('opinionated-machine').GatewayManifest} */
export const acceptanceManifest = {
  manifestVersion: '1',
  service: 'gateway-kong-acceptance',
  generatedAt: '2026-05-06T00:00:00.000Z',
  routes: [
    {
      id: 'echo.get',
      method: 'GET',
      path: '/echo',
      controller: 'echo',
      routeKey: 'get',
      // No request timeout — Kong CE has no per-route timeout override, so
      // we let /slow's tighter timeout drive the service-level read_timeout.
      metadata: { upstream: 'upstream' },
    },
    {
      id: 'echo.slow',
      method: 'GET',
      path: '/slow',
      controller: 'echo',
      routeKey: 'slow',
      // 200ms timeout; the upstream takes 2000ms so Kong should return 504.
      metadata: { upstream: 'upstream', timeouts: { request: '200ms' } },
    },
  ],
}
