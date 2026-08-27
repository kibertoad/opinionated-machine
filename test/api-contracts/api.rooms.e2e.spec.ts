import { defineApiContract, sseBody } from '@lokalise/api-contracts'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod/v4'
import { defineEvent, SSEHttpClient, SSERoomBroadcaster, SSERoomManager } from '../../index.js'
import { buildApiRoute, getSessionRooms } from '../../lib/api-contracts/index.ts'
import { createSSETestServer, type SSETestServerWithResources } from '../sseTestServerFactory.js'

/**
 * Rooms in the modern api-contracts path (buildApiRoute + options.sseRooms).
 *
 * The flagship dual-mode pattern for the polling-fallback feature: the SSE
 * branch of a dual-mode route joins a room and receives broadcasts pushed by
 * a domain service, while the sync branch of the SAME route answers JSON
 * polls. Without `sseRooms`, room membership in this path is inert.
 */

const messageEvent = defineEvent('message', z.object({ from: z.string(), text: z.string() }))

const roomStreamContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Dual-mode room stream',
  pathResolver: ({ roomId }) => `/api/rooms-modern/${roomId}/stream`,
  requestPathParamsSchema: z.object({ roomId: z.string() }),
  responsesByStatusCode: {
    200: {
      content: {
        'application/json': z.object({ roomId: z.string(), source: z.string() }),
        'text/event-stream': sseBody({
          message: z.object({ from: z.string(), text: z.string() }),
        }),
      },
    },
  },
})

describe('buildApiRoute rooms E2E (dual-mode + keepAlive + sseRooms)', () => {
  let server: SSETestServerWithResources<undefined>
  let broadcaster: SSERoomBroadcaster

  beforeEach(async () => {
    const sseRoomManager = new SSERoomManager()
    broadcaster = new SSERoomBroadcaster({ sseRoomManager })

    server = await createSSETestServer(
      (app) => {
        app.route(
          buildApiRoute(
            roomStreamContract,
            (request, _reply, { expectedContentType, sse }) => {
              if (expectedContentType === 'text/event-stream') {
                const session = sse.start('keepAlive')
                getSessionRooms(session).join(`room:${request.params.roomId}`)
                return
              }
              return {
                status: 200,
                contentType: 'application/json',
                body: { roomId: request.params.roomId, source: 'poll' },
              }
            },
            { sseRooms: broadcaster },
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
  })

  afterEach(async () => {
    await server.close()
  })

  it(
    'delivers room broadcasts to a session opened via buildApiRoute',
    { timeout: 10000 },
    async () => {
      const client = await SSEHttpClient.connect(server.baseUrl, '/api/rooms-modern/alpha/stream')

      // Wait until the server-side session has joined the room
      await vi.waitFor(() => {
        expect(broadcaster.getConnectionCountInRoom('room:alpha')).toBe(1)
      })

      const eventsPromise = client.collectEvents(1, 5000)
      const delivered = await broadcaster.broadcastToRoom('room:alpha', messageEvent, {
        from: 'service',
        text: 'hello room',
      })
      expect(delivered).toBe(1)

      const events = await eventsPromise
      expect(events).toHaveLength(1)
      expect(events[0]!.event).toBe('message')
      expect(JSON.parse(events[0]!.data)).toEqual({ from: 'service', text: 'hello room' })

      client.close()
    },
  )

  it('scopes broadcasts to the joined room', { timeout: 10000 }, async () => {
    const clientAlpha = await SSEHttpClient.connect(
      server.baseUrl,
      '/api/rooms-modern/alpha/stream',
    )
    const clientBeta = await SSEHttpClient.connect(server.baseUrl, '/api/rooms-modern/beta/stream')

    await vi.waitFor(() => {
      expect(broadcaster.getConnectionCountInRoom('room:alpha')).toBe(1)
      expect(broadcaster.getConnectionCountInRoom('room:beta')).toBe(1)
    })

    const alphaEvents = clientAlpha.collectEvents(1, 5000)
    const delivered = await broadcaster.broadcastToRoom('room:alpha', messageEvent, {
      from: 'service',
      text: 'alpha only',
    })
    expect(delivered).toBe(1)

    const events = await alphaEvents
    expect(JSON.parse(events[0]!.data)).toEqual({ from: 'service', text: 'alpha only' })

    clientAlpha.close()
    clientBeta.close()
  })

  it(
    'answers JSON polls on the same route while a room session is live',
    { timeout: 10000 },
    async () => {
      const client = await SSEHttpClient.connect(server.baseUrl, '/api/rooms-modern/alpha/stream')
      await vi.waitFor(() => {
        expect(broadcaster.getConnectionCountInRoom('room:alpha')).toBe(1)
      })

      // Cross-branch: an Accept: application/json request to the same path
      // is served by the sync handler — the deadman-poll side of the pattern.
      const pollResponse = await server.app.inject({
        method: 'GET',
        url: '/api/rooms-modern/alpha/stream',
        headers: { accept: 'application/json' },
      })
      expect(pollResponse.statusCode).toBe(200)
      expect(pollResponse.headers['content-type']).toContain('application/json')
      expect(JSON.parse(pollResponse.body)).toEqual({ roomId: 'alpha', source: 'poll' })

      // The room membership is unaffected by the poll
      expect(broadcaster.getConnectionCountInRoom('room:alpha')).toBe(1)

      client.close()
    },
  )

  it('cleans up room membership when the client disconnects', { timeout: 10000 }, async () => {
    const client = await SSEHttpClient.connect(server.baseUrl, '/api/rooms-modern/alpha/stream')
    await vi.waitFor(() => {
      expect(broadcaster.getConnectionCountInRoom('room:alpha')).toBe(1)
    })

    client.close()

    await vi.waitFor(() => {
      expect(broadcaster.getConnectionCountInRoom('room:alpha')).toBe(0)
    })

    // Broadcasting into the now-empty room delivers to nobody
    const delivered = await broadcaster.broadcastToRoom('room:alpha', messageEvent, {
      from: 'service',
      text: 'anyone there?',
    })
    expect(delivered).toBe(0)
  })

  it('delivers to multiple sessions in the same room', { timeout: 10000 }, async () => {
    const clientA = await SSEHttpClient.connect(server.baseUrl, '/api/rooms-modern/shared/stream')
    const clientB = await SSEHttpClient.connect(server.baseUrl, '/api/rooms-modern/shared/stream')

    await vi.waitFor(() => {
      expect(broadcaster.getConnectionCountInRoom('room:shared')).toBe(2)
    })

    const eventsA = clientA.collectEvents(1, 5000)
    const eventsB = clientB.collectEvents(1, 5000)

    const delivered = await broadcaster.broadcastToRoom('room:shared', messageEvent, {
      from: 'service',
      text: 'both of you',
    })
    expect(delivered).toBe(2)

    expect(JSON.parse((await eventsA)[0]!.data)).toEqual({ from: 'service', text: 'both of you' })
    expect(JSON.parse((await eventsB)[0]!.data)).toEqual({ from: 'service', text: 'both of you' })

    clientA.close()
    clientB.close()
  })
})
