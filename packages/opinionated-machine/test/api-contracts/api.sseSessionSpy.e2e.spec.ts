import { defineApiContract, sseBody } from '@lokalise/api-contracts'
import type { RouteOptions } from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod/v4'
import { type CreateSSESessionSpyResult, createSSESessionSpy, SSEHttpClient } from '../../index.js'
import {
  AbstractApiController,
  type ApiRouteOptions,
  buildApiRoute,
} from '../../lib/api-contracts/index.ts'
import { createSSETestServer, type SSETestServerWithResources } from '../sseTestServerFactory.js'

const spiedStreamContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Spied stream',
  pathResolver: () => '/api/spied/stream',
  responsesByStatusCode: {
    200: { content: { 'text/event-stream': sseBody({ ping: z.object({ seq: z.number() }) }) } },
  },
})

/** Same shape, but registered on a route that declares lifecycle hooks of its own. */
const composedStreamContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Spied stream with the route own hooks',
  pathResolver: () => '/api/spied/composed',
  responsesByStatusCode: {
    200: { content: { 'text/event-stream': sseBody({ ping: z.object({ seq: z.number() }) }) } },
  },
})

/** Same shape again, served by an `AbstractApiController` rather than a bare route. */
const controllerStreamContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Spied stream owned by a controller',
  pathResolver: () => '/api/spied/controller',
  responsesByStatusCode: {
    200: { content: { 'text/event-stream': sseBody({ ping: z.object({ seq: z.number() }) }) } },
  },
})

/**
 * The seam a controller needs for a test to be able to spy on its SSE route:
 * route options are taken as a dependency and threaded into `buildApiRoute`,
 * because the builder captures the lifecycle hooks when the route is built.
 */
class SpiedStreamController extends AbstractApiController<typeof SpiedStreamController.contracts> {
  static contracts = { stream: controllerStreamContract } as const

  readonly routes: Record<keyof typeof SpiedStreamController.contracts, RouteOptions>

  constructor(sseRouteOptions?: ApiRouteOptions<typeof controllerStreamContract>) {
    super()
    this.routes = {
      stream: buildApiRoute(
        SpiedStreamController.contracts.stream,
        (_request, _reply, { sse }) => {
          sse.start('keepAlive')
        },
        sseRouteOptions,
      ),
    }
  }
}

/**
 * Covers the `buildApiRoute` path, which has no controller to read a
 * `connectionSpy` off of: a standalone spy is wired via route hooks instead.
 */
describe('createSSESessionSpy — buildApiRoute E2E', () => {
  let server: SSETestServerWithResources<{
    spy: CreateSSESessionSpyResult['spy']
    connectedByRoute: string[]
  }>
  let openClients: SSEHttpClient[]

  beforeEach(async () => {
    openClients = []
    const { spy, routeOptions, withSpy } = createSSESessionSpy()
    // Stands in for a lifecycle hook the route under test owns in production.
    const connectedByRoute: string[] = []

    server = await createSSETestServer(
      (app) => {
        app.route(
          buildApiRoute(
            spiedStreamContract,
            (_request, _reply, { sse }) => {
              sse.start('keepAlive')
            },
            { ...routeOptions },
          ),
        )
        app.route(
          buildApiRoute(
            composedStreamContract,
            (_request, _reply, { sse }) => {
              sse.start('keepAlive')
            },
            withSpy({
              onConnect: (connection) => {
                connectedByRoute.push(connection.id)
              },
            }),
          ),
        )
        for (const route of Object.values(new SpiedStreamController(routeOptions).routes)) {
          app.route(route)
        }
      },
      {
        configureApp: (app) => {
          app.setValidatorCompiler(validatorCompiler)
          app.setSerializerCompiler(serializerCompiler)
        },
        setup: () => ({ spy, connectedByRoute }),
      },
    )
  })

  afterEach(async () => {
    for (const client of openClients) {
      client.close()
    }
    await server.close()
  })

  it('resolves the server-side session, ready to send events', async () => {
    const { spy } = server.resources

    const { client, serverConnection } = await SSEHttpClient.connect(
      server.baseUrl,
      '/api/spied/stream',
      { awaitServerConnection: { spy } },
    )
    openClients.push(client)

    // No race: the session is registered, so it can be used right away
    expect(spy.isConnected(serverConnection.id)).toBe(true)
    await serverConnection.send('ping', { seq: 1 })

    const events = await client.collectEvents(1, 5000)
    expect(events[0]!.event).toBe('ping')
    expect(JSON.parse(events[0]!.data)).toEqual({ seq: 1 })

    client.close()
  })

  it('matches the connection by the requested path with query params', async () => {
    const { spy } = server.resources

    const { client, serverConnection } = await SSEHttpClient.connect(
      server.baseUrl,
      '/api/spied/stream',
      { query: { userId: 'user-1' }, awaitServerConnection: { spy } },
    )
    openClients.push(client)

    expect(serverConnection.request.url).toBe('/api/spied/stream?userId=user-1')

    client.close()
  })

  it('tracks disconnection when the client goes away', async () => {
    const { spy } = server.resources

    const { client, serverConnection } = await SSEHttpClient.connect(
      server.baseUrl,
      '/api/spied/stream',
      { awaitServerConnection: { spy } },
    )

    client.close()
    await spy.waitForDisconnection(serverConnection.id, { timeout: 5000 })

    expect(spy.isConnected(serverConnection.id)).toBe(false)
    expect(spy.getEvents(serverConnection.id).map((event) => event.type)).toEqual([
      'connect',
      'disconnect',
    ])
  })

  it('times out when no connection is established', async () => {
    const { spy } = server.resources

    await expect(spy.waitForConnection({ timeout: 50 })).rejects.toThrow(
      'Timeout waiting for connection after 50ms',
    )
  })

  it('closes the HTTP connection when the server-side wait times out', async () => {
    const { spy } = server.resources
    // A spy that was never wired into the route: `connect()` opens a real
    // keep-alive stream and then times out waiting for a registration that can
    // never arrive.
    const { spy: unwiredSpy } = createSSESessionSpy()
    const observed = spy.waitForConnection({ timeout: 5000 })

    await expect(
      SSEHttpClient.connect(server.baseUrl, '/api/spied/stream', {
        awaitServerConnection: { spy: unwiredSpy, timeout: 100 },
      }),
    ).rejects.toThrow('Timeout waiting for connection after 100ms')

    // The caller got no client handle, so `connect()` has to close the stream
    // itself. Left open it would keep the socket alive and hang `server.close()`.
    const session = await observed
    await spy.waitForDisconnection(session.id, { timeout: 5000 })
    expect(spy.isConnected(session.id)).toBe(false)
  })

  it('spies on a route owned by a controller that accepts route options', async () => {
    const { spy } = server.resources

    const { client, serverConnection } = await SSEHttpClient.connect(
      server.baseUrl,
      '/api/spied/controller',
      { awaitServerConnection: { spy } },
    )
    openClients.push(client)

    await serverConnection.send('ping', { seq: 7 })
    const events = await client.collectEvents(1, 5000)
    expect(JSON.parse(events[0]!.data)).toEqual({ seq: 7 })

    client.close()
  })

  it('composes the route own hooks instead of replacing them', async () => {
    const { spy, connectedByRoute } = server.resources

    const { client, serverConnection } = await SSEHttpClient.connect(
      server.baseUrl,
      '/api/spied/composed',
      { awaitServerConnection: { spy } },
    )
    openClients.push(client)

    // Both the route's own hook and the spy saw the connection
    expect(connectedByRoute).toEqual([serverConnection.id])
    await serverConnection.send('ping', { seq: 1 })
    const events = await client.collectEvents(1, 5000)
    expect(events[0]!.event).toBe('ping')

    client.close()
  })
})
