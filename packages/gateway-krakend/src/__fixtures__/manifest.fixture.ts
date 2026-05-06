import type { GatewayManifest } from 'opinionated-machine'

export const fixtureManifest: GatewayManifest = {
  manifestVersion: '1',
  service: 'users-api',
  generatedAt: '2026-05-06T00:00:00.000Z',
  routes: [
    {
      id: 'usersController.createItem',
      method: 'POST',
      path: '/users',
      controller: 'usersController',
      routeKey: 'createItem',
      metadata: {
        upstream: 'users-service',
        timeouts: { request: '5s' },
        circuitBreaker: { maxRequests: 100, maxRetries: 3 },
        rateLimit: { requests: 10, per: '1m', key: 'ip' },
      },
    },
    {
      id: 'usersController.getItem',
      method: 'GET',
      path: '/users/{userId}',
      controller: 'usersController',
      routeKey: 'getItem',
      metadata: {
        upstream: 'users-service',
        cache: { ttl: '60s', vary: ['Accept-Language'] },
        cors: {
          origins: ['https://app.example.com'],
          credentials: true,
        },
      },
    },
    {
      id: 'usersController.listItems',
      method: 'GET',
      path: '/v2/users',
      controller: 'usersController',
      routeKey: 'listItems',
      metadata: {
        upstream: 'users-service',
        rewrite: { stripPrefix: '/v2' },
        auth: {
          jwt: { issuer: 'https://auth.example.com', audiences: ['users-api'] },
        },
        extensions: {
          krakend: {
            'qos/http-cache': { ttl: '10s' },
          },
        },
      },
    },
  ],
}
