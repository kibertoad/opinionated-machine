import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { z } from 'zod/v4'
import { type CreateSSESessionSpyResult, createSSESessionSpy, SSEHttpClient } from '../../index.js'
import { createHandlerGate, type HandlerGate } from '../api-contracts/fixtures/sseStreamTestApp.ts'
import { createSSETestServer, type SSETestServerWithResources } from '../sseTestServerFactory.js'
import {
  registerHttpE2eRoutes,
  type serializationPayloadSchema,
} from './fixtures/httpE2eFixtures.ts'

/**
 * `SSEHttpClient` over real HTTP connections against `buildApiRoute` SSE routes:
 * long-lived sessions driven from the test, stream termination, wire format,
 * `Last-Event-ID` reconnection, `SSESessionSpy` waiting semantics and request bodies.
 */

const NOTIFICATIONS_PATH = '/api/notifications/stream'

let server: SSETestServerWithResources<undefined>
let spy: CreateSSESessionSpyResult['spy']
let slowWorkGate: HandlerGate
let openClients: SSEHttpClient[]

function track<T extends SSEHttpClient | { client: SSEHttpClient }>(connection: T): T {
  openClients.push(connection instanceof SSEHttpClient ? connection : connection.client)
  return connection
}

function connectNotifications(userId: string) {
  return SSEHttpClient.connect(server.baseUrl, NOTIFICATIONS_PATH, {
    query: { userId },
    awaitServerConnection: { spy },
  }).then(track)
}

beforeEach(async () => {
  openClients = []
  const spyResult = createSSESessionSpy()
  spy = spyResult.spy
  slowWorkGate = createHandlerGate()

  server = await createSSETestServer(
    (app) => registerHttpE2eRoutes(app, { spy: spyResult, slowWorkGate }),
    {
      configureApp: (app) => {
        app.setValidatorCompiler(validatorCompiler)
        app.setSerializerCompiler(serializerCompiler)
      },
    },
  )
})

afterEach(async () => {
  // Unblock any handler still parked on the gate, so server.close() does not hang
  slowWorkGate.release()
  for (const client of openClients) {
    client.close()
  }
  await server.close()
})

describe('SSE HTTP E2E (long-lived connections)', () => {
  it('keeps concurrent connections apart', { timeout: 10000 }, async () => {
    const first = await connectNotifications('user-1')
    const second = await connectNotifications('user-2')

    // Each connect() claimed the session opened by its own request
    expect(first.serverConnection.context).toEqual({ userId: 'user-1' })
    expect(second.serverConnection.context).toEqual({ userId: 'user-2' })

    const firstEvents = first.client.collectEvents(2)
    const secondEvents = second.client.collectEvents(1)

    await first.serverConnection.send('notification', { id: '1', message: 'For user 1' })
    await second.serverConnection.send('notification', { id: '2', message: 'For user 2' })
    await first.serverConnection.send('notification', { id: '3', message: 'For user 1 again' })

    expect((await firstEvents).map((e) => JSON.parse(e.data).message)).toEqual([
      'For user 1',
      'For user 1 again',
    ])
    expect((await secondEvents).map((e) => JSON.parse(e.data).message)).toEqual(['For user 2'])
  })

  it(
    'ends the events() generator cleanly when the server closes the session',
    { timeout: 10000 },
    async () => {
      const { client, serverConnection } = await connectNotifications('server-close')

      await serverConnection.send('notification', { id: '1', message: 'Before server close' })

      const collected: string[] = []
      const consumed = (async () => {
        for await (const event of client.events()) {
          collected.push(JSON.parse(event.data).message)
          serverConnection.close()
        }
      })()

      await consumed
      expect(collected).toEqual(['Before server close'])
      expect(client.isClosed).toBe(true)
    },
  )

  it(
    'returns what it got from collectEvents when the server closes the session early',
    { timeout: 10000 },
    async () => {
      const { client, serverConnection } = await connectNotifications('server-close-collect')

      const collecting = client.collectEvents(5, 5000)
      await serverConnection.send('notification', { id: '1', message: 'Only event' })
      serverConnection.close()

      // Resolves with the single event instead of waiting out the timeout
      const events = await collecting
      expect(events.map((e) => JSON.parse(e.data).message)).toEqual(['Only event'])
    },
  )

  it('reports a send to a client that went away as not delivered', { timeout: 10000 }, async () => {
    const { client, serverConnection } = await connectNotifications('client-gone')

    client.close()
    await spy.waitForDisconnection(serverConnection.id)

    expect(serverConnection.isConnected()).toBe(false)
    await expect(
      serverConnection.send('notification', { id: '1', message: 'After disconnect' }),
    ).resolves.toBe(false)
  })
})

describe('SSE HTTP E2E (wire format)', () => {
  it('round-trips JSON payloads of every shape', { timeout: 10000 }, async () => {
    const { client, serverConnection } = await connectNotifications('serialization')

    const payload: z.input<typeof serializationPayloadSchema> = {
      // Newlines would split an SSE data line if the payload were not encoded
      message: 'Special: "quotes", \'apostrophes\', newlines\nand\r\ntabs\t, unicode: 日本語 🎉',
      metadata: {
        nested: { deeply: { value: 42, array: [1, 2, 3] } },
        tags: ['a', 'b', 'c'],
      },
      optionalField: null,
      integer: 42,
      float: Math.PI,
      negative: -100,
      scientific: 1.5e10,
      isActive: true,
      isDeleted: false,
    }

    const collecting = client.collectEvents(1)
    await serverConnection.send('payload', payload)

    const [event] = await collecting
    expect(JSON.parse(event!.data)).toEqual(payload)
  })

  it('carries event names and ids to the client', { timeout: 10000 }, async () => {
    const { client, serverConnection } = await connectNotifications('metadata')

    const collecting = client.collectEvents(2)
    await serverConnection.send('notification', { id: '1', message: 'hi' }, { id: 'evt-123' })
    await serverConnection.send('alert', { level: 'high' })

    const events = await collecting
    expect(events.map(({ event, id }) => ({ event, id }))).toEqual([
      { event: 'notification', id: 'evt-123' },
      { event: 'alert', id: undefined },
    ])
  })
})

describe('SSE HTTP E2E (Last-Event-ID reconnection)', () => {
  it(
    'replays the events after the Last-Event-ID the client sends, then streams live',
    { timeout: 10000 },
    async () => {
      const { client, serverConnection } = await SSEHttpClient.connect(
        server.baseUrl,
        '/api/replayable/stream',
        { headers: { 'last-event-id': '1' }, awaitServerConnection: { spy } },
      ).then(track)

      const replayed = await client.collectEvents(2)
      expect(replayed.map(({ id, data }) => ({ id, data: JSON.parse(data) }))).toEqual([
        { id: '2', data: { seq: 2 } },
        { id: '3', data: { seq: 3 } },
      ])

      const live = client.collectEvents(1)
      await serverConnection.send('update', { seq: 4 }, { id: '4' })
      expect((await live)[0]!.id).toBe('4')
    },
  )

  it('replays nothing on a first connection', { timeout: 10000 }, async () => {
    const { client, serverConnection } = await SSEHttpClient.connect(
      server.baseUrl,
      '/api/replayable/stream',
      { awaitServerConnection: { spy } },
    ).then(track)

    const collecting = client.collectEvents(1)
    await serverConnection.send('update', { seq: 4 }, { id: '4' })

    // The first event on the wire is the live one, not history
    expect((await collecting)[0]!.id).toBe('4')
  })
})

describe('SSE HTTP E2E (SSESessionSpy over real sessions)', () => {
  it('waitForConnection returns a session that registered before the wait', async () => {
    const client = track(
      await SSEHttpClient.connect(server.baseUrl, NOTIFICATIONS_PATH, {
        query: { userId: 'already-connected' },
      }),
    )
    await vi.waitFor(() => expect(spy.getEvents()).toHaveLength(1))

    const connection = await spy.waitForConnection({ timeout: 100 })

    expect(connection.context).toEqual({ userId: 'already-connected' })
    expect(client.response.ok).toBe(true)
  })

  it('a waiting predicate skips connections it does not match', { timeout: 10000 }, async () => {
    const waiting = spy.waitForConnection({
      predicate: (connection) => connection.request.url.includes('userId=wanted'),
    })

    track(
      await SSEHttpClient.connect(server.baseUrl, NOTIFICATIONS_PATH, {
        query: { userId: 'other' },
      }),
    )
    track(
      await SSEHttpClient.connect(server.baseUrl, NOTIFICATIONS_PATH, {
        query: { userId: 'wanted' },
      }),
    )

    const connection = await waiting
    expect(connection.context).toEqual({ userId: 'wanted' })
  })

  it('waitForDisconnection times out while the session stays open', async () => {
    const { serverConnection } = await connectNotifications('stays-open')

    await expect(spy.waitForDisconnection(serverConnection.id, { timeout: 100 })).rejects.toThrow(
      'Timeout waiting for disconnection after 100ms',
    )
    expect(spy.isConnected(serverConnection.id)).toBe(true)
  })

  it('resolves every waiter for a session once it closes', { timeout: 10000 }, async () => {
    const { serverConnection } = await connectNotifications('multi-waiter')

    const waiters = [1, 2, 3].map(() => spy.waitForDisconnection(serverConnection.id))
    serverConnection.close()

    await Promise.all(waiters)
    expect(spy.isConnected(serverConnection.id)).toBe(false)
  })

  it('waitForDisconnection resolves at once for a session that already closed', async () => {
    const { serverConnection } = await connectNotifications('already-closed')
    serverConnection.close()
    await vi.waitFor(() => expect(spy.isConnected(serverConnection.id)).toBe(false))

    await expect(
      spy.waitForDisconnection(serverConnection.id, { timeout: 1 }),
    ).resolves.toBeUndefined()
  })

  it('clear() rejects pending waiters and forgets recorded sessions', async () => {
    const { serverConnection } = await connectNotifications('clear')

    const connectionWaiter = spy.waitForConnection({ timeout: 5000 })
    const disconnectionWaiter = spy.waitForDisconnection(serverConnection.id, { timeout: 5000 })

    spy.clear()

    await expect(connectionWaiter).rejects.toThrow('SessionSpy was cleared')
    await expect(disconnectionWaiter).rejects.toThrow('SessionSpy was cleared')
    expect(spy.getEvents()).toEqual([])
    expect(spy.isConnected(serverConnection.id)).toBe(false)
  })
})

describe('SSE HTTP E2E (large content streaming)', () => {
  it('streams 10MB of content without data loss', { timeout: 10000 }, async () => {
    // 10MB total: 1000 chunks × 10KB each, far more than one network read
    const chunkCount = 1000
    const chunkSize = 10000

    const client = track(
      await SSEHttpClient.connect(server.baseUrl, '/api/large-content/stream', {
        method: 'POST',
        body: { chunkCount, chunkSize },
      }),
    )

    const events = await client.collectEvents((event) => event.event === 'done', 8000)
    const chunks = events.filter((e) => e.event === 'chunk').map((e) => JSON.parse(e.data))

    expect(chunks).toHaveLength(chunkCount)
    for (const [i, chunk] of chunks.entries()) {
      expect(chunk.index).toBe(i)
      expect(chunk.content).toHaveLength(chunkSize)
    }
    expect(chunks[chunkCount - 1].content.startsWith(`[chunk-${chunkCount - 1}]`)).toBe(true)
    expect(JSON.parse(events.at(-1)!.data)).toEqual({
      totalChunks: chunkCount,
      totalBytes: chunkCount * chunkSize,
    })
  })
})

describe('SSE HTTP E2E (POST endpoints)', () => {
  it('streams events from a POST endpoint with a JSON body', async () => {
    const client = track(
      await SSEHttpClient.connect(server.baseUrl, '/api/chat/completions', {
        method: 'POST',
        body: { message: 'hello streaming world', stream: true },
      }),
    )

    expect(client.response.status).toBe(200)
    expect(client.response.headers.get('content-type')).toContain('text/event-stream')

    const events = await client.collectEvents((event) => event.event === 'done')
    const chunks = events.filter((e) => e.event === 'chunk').map((e) => JSON.parse(e.data).content)

    expect(chunks).toEqual(['hello', 'streaming', 'world'])
    expect(JSON.parse(events.at(-1)!.data)).toEqual({ totalTokens: 3 })
  })

  it('sends a raw string body verbatim and honours an explicit content-type', async () => {
    const client = track(
      await SSEHttpClient.connect(server.baseUrl, '/api/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ message: 'raw body', stream: true }),
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    expect(client.response.status).toBe(200)

    const events = await client.collectEvents((event) => event.event === 'done')
    expect(events.filter((e) => e.event === 'chunk')).toHaveLength(2)
  })

  it('rejects a body on a GET request', async () => {
    await expect(
      SSEHttpClient.connect(server.baseUrl, '/api/chat/completions', {
        body: { message: 'hi', stream: true },
      }),
    ).rejects.toThrow('a request body requires a non-GET method')
  })

  it('rejects a body on a lowercase GET request too', async () => {
    await expect(
      SSEHttpClient.connect(server.baseUrl, '/api/chat/completions', {
        method: 'get',
        body: { message: 'hi', stream: true },
      }),
    ).rejects.toThrow('a request body requires a non-GET method')
  })

  it('resolves the server-side connection for a POST request', async () => {
    const { client, serverConnection } = await SSEHttpClient.connect(
      server.baseUrl,
      '/api/slow-start/stream',
      {
        method: 'POST',
        body: { prompt: 'awaited' },
        awaitServerConnection: { spy },
      },
    ).then(track)

    expect(serverConnection.request.method).toBe('POST')
    expect(serverConnection.request.url).toBe('/api/slow-start/stream')

    slowWorkGate.release()

    const events = await client.collectEvents((event) => event.event === 'done')
    expect(JSON.parse(events[0]!.data)).toEqual({ content: 'awaited' })
  })

  it('accepts the lowercase method spelling used by route contracts', async () => {
    const { client, serverConnection } = await SSEHttpClient.connect(
      server.baseUrl,
      '/api/slow-start/stream',
      {
        method: 'post',
        body: { prompt: 'lowercase method' },
        awaitServerConnection: { spy },
      },
    ).then(track)

    expect(serverConnection.request.method).toBe('POST')

    slowWorkGate.release()

    const events = await client.collectEvents((event) => event.event === 'done')
    expect(JSON.parse(events[0]!.data)).toEqual({ content: 'lowercase method' })
  })

  it('surfaces a failure raised before sse.start() as the declared JSON status', async () => {
    const client = track(
      await SSEHttpClient.connect(server.baseUrl, '/api/slow-start/stream', {
        method: 'POST',
        body: { prompt: 'tell me a story', failBeforeStart: true },
      }),
    )

    expect(client.response.status).toBe(503)
    expect(client.response.headers.get('content-type')).not.toContain('text/event-stream')

    // Body is still readable as JSON - events were never consumed, so it isn't locked
    await expect(client.response.json()).resolves.toEqual({ message: 'Upstream unavailable' })
  })

  it('sends a URLSearchParams body form-encoded instead of JSON-stringifying it', async () => {
    const { client, serverConnection } = await SSEHttpClient.connect(
      server.baseUrl,
      '/api/slow-start/stream',
      {
        method: 'POST',
        body: new URLSearchParams({ prompt: 'form encoded prompt' }),
        awaitServerConnection: { spy },
      },
    ).then(track)

    // fetch() describes the encoding itself - we must not have overwritten it with JSON
    expect(serverConnection.request.headers['content-type']).toContain(
      'application/x-www-form-urlencoded',
    )

    slowWorkGate.release()

    const events = await client.collectEvents((event) => event.event === 'done')
    expect(JSON.parse(events[0]!.data)).toEqual({ content: 'form encoded prompt' })
  })

  it('sends a typed array body verbatim', async () => {
    slowWorkGate.release()

    const client = track(
      await SSEHttpClient.connect(server.baseUrl, '/api/slow-start/stream', {
        method: 'POST',
        body: Buffer.from(JSON.stringify({ prompt: 'binary prompt' })),
      }),
    )

    expect(client.response.status).toBe(200)

    const events = await client.collectEvents((event) => event.event === 'done')
    expect(JSON.parse(events[0]!.data)).toEqual({ content: 'binary prompt' })
  })

  it('streams a ReadableStream body to the server', async () => {
    slowWorkGate.release()

    const payload = JSON.stringify({ prompt: 'streamed prompt' })
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload))
        controller.close()
      },
    })

    const client = track(
      await SSEHttpClient.connect(server.baseUrl, '/api/slow-start/stream', {
        method: 'POST',
        body,
      }),
    )

    expect(client.response.status).toBe(200)

    const events = await client.collectEvents((event) => event.event === 'done')
    expect(JSON.parse(events[0]!.data)).toEqual({ content: 'streamed prompt' })
  })

  it('rejects a body that cannot be serialized to JSON', async () => {
    await expect(
      SSEHttpClient.connect(server.baseUrl, '/api/chat/completions', {
        method: 'POST',
        body: () => 'not serializable',
      }),
    ).rejects.toThrow('cannot be serialized to JSON')
  })

  it('exposes a bodiless response instead of failing to construct the client', async () => {
    const client = track(
      await SSEHttpClient.connect(server.baseUrl, '/api/no-content', {
        method: 'POST',
      }),
    )

    expect(client.response.status).toBe(204)

    // Only consuming events reports the missing stream, and it says what to do instead
    await expect(client.collectEvents(1)).rejects.toThrow(
      'SSE response has no body to stream (status 204)',
    )
  })
})
