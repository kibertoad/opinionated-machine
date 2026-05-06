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
        rateLimit: { requests: 10, per: '1m', key: 'ip' },
        headers: {
          request: { add: { 'x-internal': 'true' }, remove: ['cookie'] },
        },
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
        timeouts: { request: '2s' },
        cache: { ttl: '60s', methods: ['GET'] },
        cors: { origins: ['https://app.example.com'], credentials: true },
        match: {
          customHeaders: { 'x-tenant-id': { prefix: 't_' } },
        },
      },
    },
    {
      id: 'usersController.deleteItem',
      method: 'DELETE',
      path: '/users/{userId}',
      controller: 'usersController',
      routeKey: 'deleteItem',
      metadata: {
        upstream: 'users-service',
        rewrite: { stripPrefix: '/users' },
        auth: {
          jwt: { issuer: 'https://auth.example.com', audiences: ['users-api'] },
        },
        circuitBreaker: { maxRequests: 100 },
      },
    },
  ],
}
