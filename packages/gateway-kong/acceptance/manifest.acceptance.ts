import type { GatewayManifest } from 'opinionated-machine'

export const acceptanceManifest: GatewayManifest = {
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
      metadata: { upstream: 'upstream', timeouts: { request: '2s' } },
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
