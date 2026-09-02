import { defineApiContract, sseBody } from '@lokalise/api-contracts'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod/v4'
import { defineEvent, SSEHttpClient, SSERoomBroadcaster, SSERoomManager } from '../../index.js'
import {
  buildApiRoute,
  getApiSseConnectionRegistry,
  getSessionRooms,
  type SSERoomsOptions,
} from '../../lib/api-contracts/index.ts'
import { createSSETestServer, type SSETestServerWithResources } from '../sseTestServerFactory.js'

/**
 * Authorization and revocation for rooms in the api-contracts path.
 *
 * Room membership decides who receives a broadcast, so it is an authorization
 * boundary. Two things follow, and both are exercised here as the pattern to
 * copy per endpoint:
 *
 * 1. A negative cross-tenant test: a principal that does not belong to a
 *    room's scope must not end up in the room, even though the handler names
 *    the room from a path param.
 * 2. A revocation test: a membership change mid-stream must be able to
 *    terminate the stream it already authorized, because the check that let it
 *    open is not re-run for the life of the connection.
 */

const messageEvent = defineEvent('message', z.object({ text: z.string() }))

const roomStreamContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Tenant-scoped room stream',
  pathResolver: ({ roomId }) => `/api/secure-rooms/${roomId}/stream`,
  requestPathParamsSchema: z.object({ roomId: z.string() }),
  responsesByStatusCode: {
    200: {
      content: {
        'text/event-stream': sseBody({ message: z.object({ text: z.string() }) }),
      },
    },
  },
})

type Harness = {
  server: SSETestServerWithResources<undefined>
  broadcaster: SSERoomBroadcaster
}

async function startServer(
  roomsOptions: (broadcaster: SSERoomBroadcaster) => SSERoomsOptions,
): Promise<Harness> {
  const sseRoomManager = new SSERoomManager()
  const broadcaster = new SSERoomBroadcaster({ sseRoomManager })

  const server = await createSSETestServer(
    (app) => {
      app.route(
        buildApiRoute(
          roomStreamContract,
          (request, _reply, { sse }) => {
            const session = sse.start('keepAlive')
            // Deliberately naive: the handler joins whatever the path says.
            // The route-level authorizeJoin is what has to stop a mismatch.
            getSessionRooms(session).join(`room:${request.params.roomId}`)
            return
          },
          { sseRooms: roomsOptions(broadcaster) },
        ),
      )
    },
    {
      configureApp: (app) => {
        app.setValidatorCompiler(validatorCompiler)
        app.setSerializerCompiler(serializerCompiler)
      },
      setup: () => undefined,
    },
  )

  return { server, broadcaster }
}

/** The tenant a request belongs to, from a header the test sets. */
function tenantOf(headers: Record<string, unknown>): string {
  const value = headers['x-tenant']
  return typeof value === 'string' ? value : ''
}

/**
 * Whether the server ended the stream within `timeoutMs`.
 *
 * These routes never push events on their own, so `collectEvents` either
 * returns empty (the stream ended) or throws its timeout (still open).
 */
async function streamEnded(client: SSEHttpClient, timeoutMs = 2_000): Promise<boolean> {
  try {
    await client.collectEvents(1, timeoutMs)
    return true
  } catch {
    return false
  }
}

/** Give a join that was going to happen time to happen. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 100))

describe('buildApiRoute rooms — join authorization', () => {
  let harness: Harness | undefined

  afterEach(async () => {
    await harness?.server.close()
    harness = undefined
  })

  it('refuses a join outside the caller tenant scope', { timeout: 10000 }, async () => {
    harness = await startServer((broadcaster) => ({
      broadcaster,
      authorizeJoin: (session, room) => room === `room:${tenantOf(session.request.headers)}`,
    }))
    const { server, broadcaster } = harness

    // The client authenticates as tenant "acme" but asks for widgetco's room.
    const client = await SSEHttpClient.connect(
      server.baseUrl,
      '/api/secure-rooms/widgetco/stream',
      {
        headers: { 'x-tenant': 'acme' },
      },
    )
    await settle()

    expect(broadcaster.getConnectionCountInRoom('room:widgetco')).toBe(0)
    const delivered = await broadcaster.broadcastToRoom('room:widgetco', messageEvent, {
      text: 'tenant-only',
    })
    expect(delivered).toBe(0)

    client.close()
  })

  it('admits a join inside the caller tenant scope', { timeout: 10000 }, async () => {
    harness = await startServer((broadcaster) => ({
      broadcaster,
      authorizeJoin: (session, room) => room === `room:${tenantOf(session.request.headers)}`,
    }))
    const { server, broadcaster } = harness

    const client = await SSEHttpClient.connect(server.baseUrl, '/api/secure-rooms/acme/stream', {
      headers: { 'x-tenant': 'acme' },
    })

    await vi.waitFor(() => {
      expect(broadcaster.getConnectionCountInRoom('room:acme')).toBe(1)
    })

    const events = client.collectEvents(1, 5000)
    await broadcaster.broadcastToRoom('room:acme', messageEvent, { text: 'hello' })
    expect(JSON.parse((await events)[0]?.data as string)).toEqual({ text: 'hello' })

    client.close()
  })

  it('honours an async verdict', { timeout: 10000 }, async () => {
    harness = await startServer((broadcaster) => ({
      broadcaster,
      authorizeJoin: (session, room) =>
        Promise.resolve(room === `room:${tenantOf(session.request.headers)}`),
    }))
    const { server, broadcaster } = harness

    const allowed = await SSEHttpClient.connect(server.baseUrl, '/api/secure-rooms/acme/stream', {
      headers: { 'x-tenant': 'acme' },
    })
    const refused = await SSEHttpClient.connect(
      server.baseUrl,
      '/api/secure-rooms/widgetco/stream',
      { headers: { 'x-tenant': 'acme' } },
    )

    await vi.waitFor(() => {
      expect(broadcaster.getConnectionCountInRoom('room:acme')).toBe(1)
    })
    expect(broadcaster.getConnectionCountInRoom('room:widgetco')).toBe(0)

    allowed.close()
    refused.close()
  })

  it('treats a throwing authorizer as a refusal', { timeout: 10000 }, async () => {
    harness = await startServer((broadcaster) => ({
      broadcaster,
      authorizeJoin: () => {
        throw new Error('membership lookup exploded')
      },
    }))
    const { server, broadcaster } = harness

    const client = await SSEHttpClient.connect(server.baseUrl, '/api/secure-rooms/acme/stream')
    await settle()

    expect(broadcaster.getConnectionCountInRoom('room:acme')).toBe(0)

    client.close()
  })

  it('joins unconditionally when no authorizer is declared', { timeout: 10000 }, async () => {
    harness = await startServer((broadcaster) => ({ broadcaster }))
    const { server, broadcaster } = harness

    const client = await SSEHttpClient.connect(
      server.baseUrl,
      '/api/secure-rooms/widgetco/stream',
      {
        headers: { 'x-tenant': 'acme' },
      },
    )

    await vi.waitFor(() => {
      expect(broadcaster.getConnectionCountInRoom('room:widgetco')).toBe(1)
    })

    client.close()
  })
})

describe('buildApiRoute rooms — revocation', () => {
  let harness: Harness | undefined

  afterEach(async () => {
    await harness?.server.close()
    harness = undefined
  })

  it('terminates a stream when its membership is revoked', { timeout: 10000 }, async () => {
    harness = await startServer((broadcaster) => ({ broadcaster }))
    const { server, broadcaster } = harness
    const registry = getApiSseConnectionRegistry(broadcaster)

    const client = await SSEHttpClient.connect(server.baseUrl, '/api/secure-rooms/acme/stream')
    await vi.waitFor(() => {
      expect(broadcaster.getConnectionCountInRoom('room:acme')).toBe(1)
    })

    const [connectionId] = broadcaster.getConnectionsInRoom('room:acme')
    expect(registry.evict(connectionId as string)).toBe(true)

    expect(await streamEnded(client)).toBe(true)
    expect(broadcaster.getConnectionCountInRoom('room:acme')).toBe(0)

    const delivered = await broadcaster.broadcastToRoom('room:acme', messageEvent, {
      text: 'after revocation',
    })
    expect(delivered).toBe(0)

    client.close()
  })

  it('closes every stream in a revoked scope', { timeout: 15000 }, async () => {
    harness = await startServer((broadcaster) => ({ broadcaster }))
    const { server, broadcaster } = harness
    const registry = getApiSseConnectionRegistry(broadcaster)

    const first = await SSEHttpClient.connect(server.baseUrl, '/api/secure-rooms/acme/stream')
    const second = await SSEHttpClient.connect(server.baseUrl, '/api/secure-rooms/acme/stream')
    const other = await SSEHttpClient.connect(server.baseUrl, '/api/secure-rooms/widgetco/stream')

    await vi.waitFor(() => {
      expect(broadcaster.getConnectionCountInRoom('room:acme')).toBe(2)
      expect(broadcaster.getConnectionCountInRoom('room:widgetco')).toBe(1)
    })

    expect(registry.closeRoom('room:acme')).toBe(2)

    expect(await streamEnded(first)).toBe(true)
    expect(await streamEnded(second)).toBe(true)
    // A different scope is untouched.
    expect(broadcaster.getConnectionCountInRoom('room:widgetco')).toBe(1)

    first.close()
    second.close()
    other.close()
  })

  it('drops one room without ending the stream', { timeout: 10000 }, async () => {
    harness = await startServer((broadcaster) => ({ broadcaster }))
    const { server, broadcaster } = harness
    const registry = getApiSseConnectionRegistry(broadcaster)

    const client = await SSEHttpClient.connect(server.baseUrl, '/api/secure-rooms/acme/stream')
    await vi.waitFor(() => {
      expect(broadcaster.getConnectionCountInRoom('room:acme')).toBe(1)
    })

    const [connectionId] = broadcaster.getConnectionsInRoom('room:acme')
    expect(registry.evictFromRoom('room:acme', connectionId as string)).toBe(true)
    expect(registry.evictFromRoom('room:acme', connectionId as string)).toBe(false)

    expect(broadcaster.getConnectionCountInRoom('room:acme')).toBe(0)
    expect(await streamEnded(client, 500)).toBe(false)

    client.close()
  })

  it('reports an unknown connection instead of throwing', { timeout: 10000 }, async () => {
    harness = await startServer((broadcaster) => ({ broadcaster }))
    const registry = getApiSseConnectionRegistry(harness.broadcaster)

    expect(registry.evict('no-such-connection')).toBe(false)
    expect(registry.closeRoom('room:empty')).toBe(0)
  })
})

describe('buildApiRoute rooms — bounded session lifetime', () => {
  let harness: Harness | undefined

  afterEach(async () => {
    await harness?.server.close()
    harness = undefined
  })

  it('closes the session once its lifetime elapses', { timeout: 10000 }, async () => {
    harness = await startServer((broadcaster) => ({ broadcaster, maxSessionLifetimeMs: 300 }))
    const { server, broadcaster } = harness

    const client = await SSEHttpClient.connect(server.baseUrl, '/api/secure-rooms/acme/stream')
    await vi.waitFor(() => {
      expect(broadcaster.getConnectionCountInRoom('room:acme')).toBe(1)
    })

    // The client sees an ordinary server close, which a reconnecting client
    // (sse-fallback) treats as a routine reconnect with a fresh token.
    expect(await streamEnded(client, 3_000)).toBe(true)
    await vi.waitFor(() => {
      expect(broadcaster.getConnectionCountInRoom('room:acme')).toBe(0)
    })

    client.close()
  })

  it('leaves the session open when no lifetime is declared', { timeout: 10000 }, async () => {
    harness = await startServer((broadcaster) => ({ broadcaster }))
    const { server, broadcaster } = harness

    const client = await SSEHttpClient.connect(server.baseUrl, '/api/secure-rooms/acme/stream')
    await vi.waitFor(() => {
      expect(broadcaster.getConnectionCountInRoom('room:acme')).toBe(1)
    })

    expect(await streamEnded(client, 500)).toBe(false)

    client.close()
  })
})
