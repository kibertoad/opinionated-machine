import { defineApiContract, sseResponse } from '@lokalise/api-contracts'
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod/v4'
import { buildApiRoute, SSEInjectClient } from '../../index.js'
import { startSSEStreamTestApp } from '../api-contracts/fixtures/sseStreamTestApp.ts'
import { createSSETestServer, type SSETestServerWithResources } from '../sseTestServerFactory.js'

/** OpenAI-style completion: one `chunk` per word of the message, then `done`. */
const chatCompletionContract = defineApiContract({
  visibility: 'public',
  method: 'post',
  summary: 'Chat completion stream',
  pathResolver: () => '/api/chat/completions',
  requestBodySchema: z.object({ message: z.string(), stream: z.literal(true) }),
  responsesByStatusCode: {
    200: sseResponse({
      chunk: z.object({ content: z.string() }),
      done: z.object({ totalTokens: z.number() }),
    }),
  },
})

/** Echoes the authorization header it received, so forwarding is observable. */
const headerEchoContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Header echo stream',
  pathResolver: () => '/api/header-echo/stream',
  requestHeaderSchema: z.object({ authorization: z.string() }),
  responsesByStatusCode: {
    200: sseResponse({ data: z.object({ authorization: z.string() }) }),
  },
})

/** Streams by default; `mode` selects a documented pre-stream JSON error instead. */
const bodyForStatusContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Stream with documented pre-stream errors',
  pathResolver: () => '/api/body-for-status/stream',
  requestQuerySchema: z.object({ mode: z.enum(['unauthorized', 'missing']).optional() }),
  responsesByStatusCode: {
    200: sseResponse({ message: z.object({ text: z.string() }) }),
    401: z.object({ message: z.string() }),
    404: z.object({ resourceId: z.string() }),
  },
})

const CHAT_PATH = chatCompletionContract.pathResolver()

/**
 * E2E tests for SSEInjectClient against `buildApiRoute` SSE routes.
 *
 * SSEInjectClient is designed for "request-response" style SSE streams where the handler sends
 * events and then closes the connection (like OpenAI completions). It uses Fastify's inject(),
 * so no listening server is needed; the app still has to carry `@fastify/sse`.
 */
describe('SSEInjectClient E2E', () => {
  describe('against buildApiRoute routes', () => {
    let server: SSETestServerWithResources<undefined>
    let client: SSEInjectClient

    beforeAll(async () => {
      server = await startSSEStreamTestApp((app) => {
        app.route(
          buildApiRoute(chatCompletionContract, async (request, _reply, { sse }) => {
            const session = sse.start('autoClose')
            const words = request.body.message.split(' ')
            for (const word of words) {
              await session.send('chunk', { content: word })
            }
            await session.send('done', { totalTokens: words.length })
          }),
        )
        app.route(
          buildApiRoute(headerEchoContract, async (request, _reply, { sse }) => {
            const session = sse.start('autoClose')
            await session.send('data', { authorization: request.headers.authorization })
          }),
        )
        app.route(
          buildApiRoute(bodyForStatusContract, async (request, _reply, { sse }) => {
            if (request.query.mode === 'unauthorized') {
              return { status: 401, body: { message: 'Unauthorized' } }
            }
            if (request.query.mode === 'missing') {
              return { status: 404, body: { resourceId: 'item-42' } }
            }
            const session = sse.start('autoClose')
            await session.send('message', { text: 'hello' })
            return
          }),
        )
      })

      client = new SSEInjectClient(server.app)
    })

    afterAll(async () => {
      await server.close()
    })

    describe('POST requests (OpenAI-style streaming)', () => {
      it('sends the JSON body and parses the streamed events in order', async () => {
        const conn = await client.connectWithBody(CHAT_PATH, {
          message: 'Hello World Test',
          stream: true,
        })

        expect(conn.getStatusCode()).toBe(200)
        expect(conn.getHeaders()['content-type']).toContain('text/event-stream')

        const events = conn.getReceivedEvents()
        expect(events.map((event) => event.event)).toEqual(['chunk', 'chunk', 'chunk', 'done'])
        expect(
          events.filter((e) => e.event === 'chunk').map((e) => JSON.parse(e.data).content),
        ).toEqual(['Hello', 'World', 'Test'])
        expect(JSON.parse(events[3]!.data)).toEqual({ totalTokens: 3 })
      })

      it('waitForEvent finds a specific event type', async () => {
        const conn = await client.connectWithBody(CHAT_PATH, { message: 'Test', stream: true })

        const doneEvent = await conn.waitForEvent('done')
        expect(JSON.parse(doneEvent.data).totalTokens).toBe(1)
      })

      it('waitForEvents returns exactly the requested count', async () => {
        const conn = await client.connectWithBody(CHAT_PATH, {
          message: 'A B C D',
          stream: true,
        })

        const events = await conn.waitForEvents(3)
        expect(events.map((e) => JSON.parse(e.data).content)).toEqual(['A', 'B', 'C'])
      })
    })

    it('forwards request headers', async () => {
      const conn = await client.connect(headerEchoContract.pathResolver(), {
        headers: { authorization: 'Bearer valid-token' },
      })

      expect(conn.getStatusCode()).toBe(200)
      const events = conn.getReceivedEvents()
      expect(events).toHaveLength(1)
      expect(JSON.parse(events[0]!.data)).toEqual({ authorization: 'Bearer valid-token' })
    })

    describe('connection state', () => {
      it('reports the connection closed, and close() is a no-op', async () => {
        const conn = await client.connectWithBody(CHAT_PATH, { message: 'Test', stream: true })

        // inject() only resolves once the response is complete
        expect(conn.isClosed()).toBe(true)
        conn.close()
        expect(conn.isClosed()).toBe(true)
      })

      it('getReceivedEvents returns a copy', async () => {
        const conn = await client.connectWithBody(CHAT_PATH, { message: 'Test', stream: true })

        const events1 = conn.getReceivedEvents()
        const events2 = conn.getReceivedEvents()

        expect(events1).not.toBe(events2)
        expect(events1).toEqual(events2)
      })
    })

    describe('response body access', () => {
      const path = bodyForStatusContract.pathResolver()

      it('exposes the JSON body of a pre-stream error response', async () => {
        const conn = await client.connect(`${path}?mode=unauthorized`)

        expect(conn.getStatusCode()).toBe(401)
        expect(conn.getReceivedEvents()).toHaveLength(0)
        expect(conn.getBody()).toBe(JSON.stringify({ message: 'Unauthorized' }))
        expect(conn.json()).toMatchObject({ message: 'Unauthorized' })
      })

      it('types the parsed body via the json() type parameter', async () => {
        const conn = await client.connect(`${path}?mode=missing`)

        expect(conn.getStatusCode()).toBe(404)

        const body = conn.json<{ resourceId: string }>()
        expectTypeOf(body).toEqualTypeOf<{ resourceId: string }>()
        expect(body.resourceId).toBe('item-42')
      })

      it('exposes the raw stream body for a streaming response', async () => {
        const conn = await client.connect(path)

        expect(conn.getStatusCode()).toBe(200)
        expect(conn.getBody()).toContain('event: message')
        // A text/event-stream body is not JSON
        expect(() => conn.json()).toThrow('json() — body is not valid JSON')
      })
    })
  })

  describe('methods beyond POST', () => {
    let server: SSETestServerWithResources<undefined>
    let client: SSEInjectClient

    beforeAll(async () => {
      // A raw route: this is about `connectWithBody` accepting every method inject() takes,
      // independent of what the contract DSL can declare
      server = await createSSETestServer((app) => {
        app.delete('/api/raw-delete-stream', (request, reply) => {
          reply.header('content-type', 'text/event-stream')
          return `event: chunk\ndata: ${JSON.stringify(request.body)}\n\n`
        })
      })

      client = new SSEInjectClient(server.app)
    })

    afterAll(async () => {
      await server.close()
    })

    it('streams a DELETE request carrying a body', async () => {
      const conn = await client.connectWithBody(
        '/api/raw-delete-stream',
        { id: 'to-delete' },
        { method: 'DELETE' },
      )

      expect(conn.getStatusCode()).toBe(200)

      const events = conn.getReceivedEvents()
      expect(events).toHaveLength(1)
      expect(JSON.parse(events[0]!.data)).toEqual({ id: 'to-delete' })
    })
  })
})
