import type { GatewayManifest } from 'opinionated-machine'

/**
 * A representative manifest covering the universal metadata fields exercised
 * by the snapshot tests. Frozen `generatedAt` so snapshots stay stable.
 */
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
        headers: {
          request: { add: { 'x-internal': 'true' }, remove: ['cookie'] },
          response: { remove: ['server'] },
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
        timeouts: { request: '5s' },
        retry: {
          attempts: 2,
          on: ['5xx', 'connect-failure'],
          perTryTimeout: '2s',
        },
        match: {
          headers: { 'x-trace-id': { regex: '^[a-f0-9]+$' } },
          customHeaders: { 'x-tenant-id': { prefix: 't_' } },
          query: { include: 'profile' },
        },
        cache: { ttl: '60s' },
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
        timeouts: { request: '3s' },
        rewrite: { stripPrefix: '/users' },
        extensions: {
          envoy: {
            // This block is merged onto the route last — escape hatch.
            decorator: { operation: 'usersController.deleteItem' },
          },
        },
      },
    },
  ],
}
