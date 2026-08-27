import { defineApiContract, sseBody } from '@lokalise/api-contracts'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod/v4'
import { type CreateSSESessionSpyResult, createSSESessionSpy, SSEHttpClient } from '../../index.js'
import { buildApiRoute } from '../../lib/api-contracts/index.ts'
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

/**
 * Covers the `buildApiRoute` path, which has no controller to read a
 * `connectionSpy` off of: a standalone spy is wired via route hooks instead.
 */
describe('createSSESessionSpy — buildApiRoute E2E', () => {
  let server: SSETestServerWithResources<{ spy: CreateSSESessionSpyResult['spy'] }>
  let openClients: SSEHttpClient[]

  beforeEach(async () => {
    openClients = []
    const { spy, routeOptions } = createSSESessionSpy()

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
      },
      {
        configureApp: (app) => {
          app.setValidatorCompiler(validatorCompiler)
          app.setSerializerCompiler(serializerCompiler)
        },
        setup: () => ({ spy }),
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
})
