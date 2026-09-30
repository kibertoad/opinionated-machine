import { defineApiContract, sseBody } from '@lokalise/api-contracts'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod/v4'
import type { SSEMessage, SSERoomAdapter, SSERoomMessageHandler } from '../../index.js'
import {
  buildApiRoute,
  createSSESessionSpy,
  getSessionRooms,
  SSEHttpClient,
  SSERoomBroadcaster,
  SSERoomManager,
  type SSESessionSpy,
} from '../../index.js'
import { createSSETestServer, type SSETestServerWithResources } from '../sseTestServerFactory.js'

/**
 * Room behaviour of `buildApiRoute` sessions that `test/api-contracts/api.rooms*.spec.ts`
 * does not cover: multi-room membership through `getSessionRooms`, and delivery of
 * broadcasts arriving from other nodes through the room adapter.
 */

/**
 * Adapter that lets a test inject a message as if another node had published it.
 */
class MockAdapter implements SSERoomAdapter {
  private messageHandler?: SSERoomMessageHandler

  connect(): Promise<void> {
    return Promise.resolve()
  }

  disconnect(): Promise<void> {
    return Promise.resolve()
  }

  subscribe(_room: string): Promise<void> {
    return Promise.resolve()
  }

  unsubscribe(_room: string): Promise<void> {
    return Promise.resolve()
  }

  publish(_room: string, _message: SSEMessage): Promise<void> {
    return Promise.resolve()
  }

  onMessage(handler: SSERoomMessageHandler): void {
    this.messageHandler = handler
  }

  simulateRemoteMessage(room: string, message: SSEMessage, sourceNodeId: string): void {
    this.messageHandler?.(room, message, sourceNodeId)
  }
}

const roomStreamContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Room stream',
  pathResolver: ({ roomId }) => `/api/rooms/${roomId}/stream`,
  requestPathParamsSchema: z.object({ roomId: z.string() }),
  requestQuerySchema: z.object({
    also: z.string().optional(),
    skip: z.string().optional(),
  }),
  responsesByStatusCode: {
    200: {
      content: {
        'text/event-stream': sseBody({ message: z.object({ from: z.string(), text: z.string() }) }),
      },
    },
  },
})

type RoomsServer = {
  server: SSETestServerWithResources<undefined>
  spy: SSESessionSpy
}

/**
 * Serves a keepAlive stream that joins the path room plus any comma-separated
 * `also` rooms in one `join()` call, then leaves any comma-separated `skip` rooms.
 */
async function startRoomsServer(broadcaster: SSERoomBroadcaster): Promise<RoomsServer> {
  const { spy, withSpy } = createSSESessionSpy()
  const server = await createSSETestServer(
    (app) => {
      app.route(
        buildApiRoute(
          roomStreamContract,
          (request, _reply, { sse }) => {
            const session = sse.start('keepAlive')
            const rooms = getSessionRooms(session)
            const also = request.query.also?.split(',') ?? []
            rooms.join([request.params.roomId, ...also])
            if (request.query.skip) rooms.leave(request.query.skip.split(','))
          },
          { ...withSpy(), sseRooms: broadcaster },
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
  return { server, spy }
}

describe('SSE rooms on buildApiRoute sessions', () => {
  describe('multi-room membership', () => {
    let broadcaster: SSERoomBroadcaster
    let server: SSETestServerWithResources<undefined>
    let spy: SSESessionSpy

    beforeEach(async () => {
      broadcaster = new SSERoomBroadcaster({ sseRoomManager: new SSERoomManager() })
      ;({ server, spy } = await startRoomsServer(broadcaster))
    })

    afterEach(async () => {
      await server.close()
    })

    it(
      'joins every room passed as an array and leaves only the named ones',
      { timeout: 10000 },
      async () => {
        const { client, serverConnection } = await SSEHttpClient.connect(
          server.baseUrl,
          '/api/rooms/lobby/stream',
          {
            query: { also: 'premium,beta,gamma', skip: 'beta' },
            awaitServerConnection: { spy },
          },
        )

        expect(broadcaster.roomManager.getRooms(serverConnection.id).sort()).toEqual([
          'gamma',
          'lobby',
          'premium',
        ])

        client.close()
      },
    )

    it('leaves every joined room when the client disconnects', { timeout: 10000 }, async () => {
      const { client, serverConnection } = await SSEHttpClient.connect(
        server.baseUrl,
        '/api/rooms/lobby/stream',
        { query: { also: 'premium,beta' }, awaitServerConnection: { spy } },
      )
      expect(broadcaster.roomManager.getRooms(serverConnection.id)).toHaveLength(3)

      client.close()

      // Room cleanup runs after the spy is notified of the close, so poll for it.
      await vi.waitFor(() => {
        expect(broadcaster.roomManager.getRooms(serverConnection.id)).toEqual([])
      })
      expect(broadcaster.roomManager.getAllRooms()).toEqual([])
    })
  })

  describe('broadcasts from other nodes', () => {
    let adapter: MockAdapter
    let server: SSETestServerWithResources<undefined>
    let spy: SSESessionSpy

    beforeEach(async () => {
      adapter = new MockAdapter()
      const broadcaster = new SSERoomBroadcaster({
        sseRoomManager: new SSERoomManager({ adapter, nodeId: 'node-1' }),
      })
      ;({ server, spy } = await startRoomsServer(broadcaster))
    })

    afterEach(async () => {
      await server.close()
    })

    async function connectToRoom(roomId: string) {
      const { client } = await SSEHttpClient.connect(
        server.baseUrl,
        `/api/rooms/${roomId}/stream`,
        { awaitServerConnection: { spy } },
      )
      return client
    }

    function remoteMessage(room: string, text: string, id?: string): void {
      adapter.simulateRemoteMessage(
        room,
        { event: 'message', data: { from: 'remote', text }, ...(id ? { id } : {}) },
        'node-2',
      )
    }

    it('delivers a remote broadcast to sessions in the room', { timeout: 10000 }, async () => {
      const client = await connectToRoom('remote-test')
      const eventsPromise = client.collectEvents(1, 5000)

      remoteMessage('remote-test', 'Hello from node 2', 'msg-1')

      const events = await eventsPromise
      expect(events[0]?.event).toBe('message')
      expect(events[0]?.id).toBe('msg-1')
      expect(JSON.parse(events[0]!.data)).toEqual({ from: 'remote', text: 'Hello from node 2' })

      client.close()
    })

    it(
      'drops a remote broadcast repeating a delivered message id',
      { timeout: 10000 },
      async () => {
        const client = await connectToRoom('dedup-test')
        const eventsPromise = client.collectEvents(2, 5000)

        remoteMessage('dedup-test', 'first', 'dup-msg-1')
        remoteMessage('dedup-test', 'first', 'dup-msg-1')
        remoteMessage('dedup-test', 'marker', 'marker-1')

        const events = await eventsPromise
        expect(events.map((event) => event.id)).toEqual(['dup-msg-1', 'marker-1'])

        client.close()
      },
    )

    it('delivers remote broadcasts without an id every time', { timeout: 10000 }, async () => {
      const client = await connectToRoom('no-id-test')
      const eventsPromise = client.collectEvents(2, 5000)

      remoteMessage('no-id-test', 'same')
      remoteMessage('no-id-test', 'same')

      const events = await eventsPromise
      expect(events.map((event) => JSON.parse(event.data).text)).toEqual(['same', 'same'])

      client.close()
    })
  })
})
