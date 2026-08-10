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
    {
      id: 'sse.stream',
      method: 'GET',
      path: '/sse',
      controller: 'sse',
      routeKey: 'stream',
      // Marked streaming: the generator disables the route timeout and idle
      // timeout, so the stream must survive event gaps longer than the HCM
      // stream_idle_timeout configured in render-config.mjs.
      streaming: 'sse',
      metadata: { upstream: 'upstream' },
    },
    {
      id: 'sse.unmarked',
      method: 'GET',
      path: '/sse-unmarked',
      controller: 'sse',
      routeKey: 'unmarked',
      // Same upstream behavior but NOT marked streaming: the HCM
      // stream_idle_timeout applies and resets the stream mid-gap.
      metadata: { upstream: 'upstream' },
    },
  ],
}
