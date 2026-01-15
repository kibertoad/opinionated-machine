import FastifySSEPlugin from '@fastify/sse'
import fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SSEInjectClient } from '../../index.js'

/**
 * E2E tests for SSEInjectClient.
 *
 * These tests validate SSEInjectClient works correctly without using contracts.
 * SSEInjectClient uses Fastify's inject() which waits for the complete response,
 * making it ideal for testing request-response style SSE streams (like OpenAI completions).
 */
describe('SSEInjectClient E2E', () => {
  let app: FastifyInstance
  let client: SSEInjectClient

  beforeEach(async () => {
    app = fastify()
    await app.register(FastifySSEPlugin as unknown as Parameters<typeof app.register>[0])
    client = new SSEInjectClient(app)
  })

  afterEach(async () => {
    await app.close()
  })

  describe('GET requests', () => {
    it('receives single event from GET endpoint', async () => {
      app.get('/api/stream', async (_request, reply) => {
        reply.sse({ event: 'message', data: { hello: 'world' } })
        reply.sseClose()
      })

      await app.ready()

      const conn = await client.connect('/api/stream')

      expect(conn.getStatusCode()).toBe(200)
      expect(conn.getHeaders()['content-type']).toContain('text/event-stream')

      const events = conn.getReceivedEvents()
      expect(events).toHaveLength(1)
      expect(events[0]!.event).toBe('message')
      expect(JSON.parse(events[0]!.data)).toEqual({ hello: 'world' })
    })

    it('receives multiple events from GET endpoint', async () => {
      app.get('/api/stream', async (_request, reply) => {
        reply.sse({ event: 'chunk', data: { content: 'Hello' } })
        reply.sse({ event: 'chunk', data: { content: ' ' } })
        reply.sse({ event: 'chunk', data: { content: 'World' } })
        reply.sse({ event: 'done', data: { totalChunks: 3 } })
        reply.sseClose()
      })

      await app.ready()

      const conn = await client.connect('/api/stream')

      expect(conn.getStatusCode()).toBe(200)

      const events = conn.getReceivedEvents()
      expect(events).toHaveLength(4)

      const chunks = events.filter((e) => e.event === 'chunk')
      expect(chunks).toHaveLength(3)
      expect(JSON.parse(chunks[0]!.data).content).toBe('Hello')
      expect(JSON.parse(chunks[1]!.data).content).toBe(' ')
      expect(JSON.parse(chunks[2]!.data).content).toBe('World')

      const doneEvent = events.find((e) => e.event === 'done')
      expect(JSON.parse(doneEvent!.data).totalChunks).toBe(3)
    })

    it('passes custom headers to GET endpoint', async () => {
      app.get('/api/stream', async (request, reply) => {
        const authHeader = request.headers.authorization
        reply.sse({ event: 'auth', data: { received: authHeader } })
        reply.sseClose()
      })

      await app.ready()

      const conn = await client.connect('/api/stream', {
        headers: { authorization: 'Bearer test-token' },
      })

      expect(conn.getStatusCode()).toBe(200)

      const events = conn.getReceivedEvents()
      expect(JSON.parse(events[0]!.data).received).toBe('Bearer test-token')
    })

    it('parses query parameters in GET endpoint', async () => {
      app.get<{ Querystring: { userId: string } }>('/api/stream', async (request, reply) => {
        reply.sse({ event: 'user', data: { userId: request.query.userId } })
        reply.sseClose()
      })

      await app.ready()

      const conn = await client.connect('/api/stream?userId=test-123')

      const events = conn.getReceivedEvents()
      expect(JSON.parse(events[0]!.data).userId).toBe('test-123')
    })

    it('handles event with custom ID', async () => {
      app.get('/api/stream', async (_request, reply) => {
        reply.sse({ id: 'evt-001', event: 'update', data: { value: 42 } })
        reply.sseClose()
      })

      await app.ready()

      const conn = await client.connect('/api/stream')

      const events = conn.getReceivedEvents()
      expect(events[0]!.id).toBe('evt-001')
      expect(events[0]!.event).toBe('update')
    })

    it('handles event without explicit event type (defaults to message)', async () => {
      app.get('/api/stream', async (_request, reply) => {
        reply.sse({ data: { implicit: true } })
        reply.sseClose()
      })

      await app.ready()

      const conn = await client.connect('/api/stream')

      const events = conn.getReceivedEvents()
      expect(events).toHaveLength(1)
      // When no event type is specified, it's undefined in our parser (browser uses 'message')
      expect(events[0]!.event).toBeUndefined()
      expect(JSON.parse(events[0]!.data).implicit).toBe(true)
    })

    it('handles error responses', async () => {
      app.get('/api/stream', async (_request, reply) => {
        reply.code(401).send({ error: 'Unauthorized' })
      })

      await app.ready()

      const conn = await client.connect('/api/stream')

      expect(conn.getStatusCode()).toBe(401)
      expect(conn.getReceivedEvents()).toHaveLength(0)
    })
  })

  describe('POST requests (OpenAI-style)', () => {
    it('streams response chunks for POST request with body', async () => {
      app.post<{ Body: { message: string } }>('/api/chat/completions', async (request, reply) => {
        const words = request.body.message.split(' ')

        for (const word of words) {
          reply.sse({ event: 'chunk', data: { content: word } })
        }

        reply.sse({ event: 'done', data: { totalWords: words.length } })
        reply.sseClose()
      })

      await app.ready()

      const conn = await client.connectWithBody('/api/chat/completions', {
        message: 'Hello World Test',
      })

      expect(conn.getStatusCode()).toBe(200)
      expect(conn.getHeaders()['content-type']).toContain('text/event-stream')

      const events = conn.getReceivedEvents()
      expect(events).toHaveLength(4) // 3 chunks + 1 done

      const chunks = events.filter((e) => e.event === 'chunk')
      expect(chunks.map((c) => JSON.parse(c.data).content)).toEqual(['Hello', 'World', 'Test'])

      const doneEvent = events.find((e) => e.event === 'done')
      expect(JSON.parse(doneEvent!.data).totalWords).toBe(3)
    })

    it('handles POST with custom headers', async () => {
      app.post<{ Body: { prompt: string } }>('/api/generate', async (request, reply) => {
        const apiKey = request.headers['x-api-key']
        reply.sse({ event: 'result', data: { prompt: request.body.prompt, apiKey } })
        reply.sseClose()
      })

      await app.ready()

      const conn = await client.connectWithBody(
        '/api/generate',
        { prompt: 'Test prompt' },
        { headers: { 'x-api-key': 'sk-test-key' } },
      )

      const events = conn.getReceivedEvents()
      const data = JSON.parse(events[0]!.data)
      expect(data.prompt).toBe('Test prompt')
      expect(data.apiKey).toBe('sk-test-key')
    })

    it('supports PUT method', async () => {
      app.put<{ Body: { value: number } }>('/api/update', async (request, reply) => {
        reply.sse({ event: 'updated', data: { newValue: request.body.value * 2 } })
        reply.sseClose()
      })

      await app.ready()

      const conn = await client.connectWithBody('/api/update', { value: 21 }, { method: 'PUT' })

      const events = conn.getReceivedEvents()
      expect(JSON.parse(events[0]!.data).newValue).toBe(42)
    })

    it('supports PATCH method', async () => {
      app.patch<{ Body: { delta: number } }>('/api/patch', async (request, reply) => {
        reply.sse({ event: 'patched', data: { delta: request.body.delta } })
        reply.sseClose()
      })

      await app.ready()

      const conn = await client.connectWithBody('/api/patch', { delta: 5 }, { method: 'PATCH' })

      const events = conn.getReceivedEvents()
      expect(JSON.parse(events[0]!.data).delta).toBe(5)
    })

    it('handles POST error responses', async () => {
      app.post('/api/chat', async (_request, reply) => {
        reply.code(400).send({ error: 'Invalid request' })
      })

      await app.ready()

      const conn = await client.connectWithBody('/api/chat', { invalid: true })

      expect(conn.getStatusCode()).toBe(400)
      expect(conn.getReceivedEvents()).toHaveLength(0)
    })
  })

  describe('waitForEvent and waitForEvents', () => {
    it('waitForEvent finds event by name', async () => {
      app.get('/api/stream', async (_request, reply) => {
        reply.sse({ event: 'start', data: { status: 'started' } })
        reply.sse({ event: 'progress', data: { percent: 50 } })
        reply.sse({ event: 'complete', data: { status: 'done' } })
        reply.sseClose()
      })

      await app.ready()

      const conn = await client.connect('/api/stream')

      const completeEvent = await conn.waitForEvent('complete')
      expect(JSON.parse(completeEvent.data).status).toBe('done')
    })

    it('waitForEvents returns requested number of events', async () => {
      app.get('/api/stream', async (_request, reply) => {
        for (let i = 1; i <= 5; i++) {
          reply.sse({ event: 'item', data: { index: i } })
        }
        reply.sseClose()
      })

      await app.ready()

      const conn = await client.connect('/api/stream')

      const events = await conn.waitForEvents(3)
      expect(events).toHaveLength(3)
      expect(JSON.parse(events[0]!.data).index).toBe(1)
      expect(JSON.parse(events[2]!.data).index).toBe(3)
    })

    it('waitForEvent times out when event not found', async () => {
      app.get('/api/stream', async (_request, reply) => {
        reply.sse({ event: 'other', data: {} })
        reply.sseClose()
      })

      await app.ready()

      const conn = await client.connect('/api/stream')

      await expect(conn.waitForEvent('nonexistent', 100)).rejects.toThrow(
        'Timeout waiting for event: nonexistent',
      )
    })
  })

  describe('data serialization', () => {
    it('handles arrays at top level', async () => {
      app.get('/api/stream', async (_request, reply) => {
        reply.sse({ event: 'list', data: [1, 2, 3] })
        reply.sseClose()
      })

      await app.ready()

      const conn = await client.connect('/api/stream')

      const events = conn.getReceivedEvents()
      expect(JSON.parse(events[0]!.data)).toEqual([1, 2, 3])
    })

    it('handles nested objects', async () => {
      app.get('/api/stream', async (_request, reply) => {
        reply.sse({
          event: 'nested',
          data: {
            user: { name: 'Test', settings: { theme: 'dark' } },
            items: [{ id: 1 }, { id: 2 }],
          },
        })
        reply.sseClose()
      })

      await app.ready()

      const conn = await client.connect('/api/stream')

      const events = conn.getReceivedEvents()
      const data = JSON.parse(events[0]!.data)
      expect(data.user.name).toBe('Test')
      expect(data.user.settings.theme).toBe('dark')
      expect(data.items).toHaveLength(2)
    })

    it('handles string data', async () => {
      app.get('/api/stream', async (_request, reply) => {
        reply.sse({ event: 'text', data: 'plain string' })
        reply.sseClose()
      })

      await app.ready()

      const conn = await client.connect('/api/stream')

      const events = conn.getReceivedEvents()
      // String data is JSON stringified, so it comes back with quotes
      expect(events[0]!.data).toBe('"plain string"')
    })

    it('handles numeric values', async () => {
      app.get('/api/stream', async (_request, reply) => {
        reply.sse({ event: 'number', data: 42 })
        reply.sse({ event: 'float', data: 3.14 })
        reply.sseClose()
      })

      await app.ready()

      const conn = await client.connect('/api/stream')

      const events = conn.getReceivedEvents()
      expect(JSON.parse(events[0]!.data)).toBe(42)
      expect(JSON.parse(events[1]!.data)).toBe(3.14)
    })

    it('handles boolean values', async () => {
      app.get('/api/stream', async (_request, reply) => {
        reply.sse({ event: 'bool', data: true })
        reply.sse({ event: 'bool', data: false })
        reply.sseClose()
      })

      await app.ready()

      const conn = await client.connect('/api/stream')

      const events = conn.getReceivedEvents()
      expect(JSON.parse(events[0]!.data)).toBe(true)
      expect(JSON.parse(events[1]!.data)).toBe(false)
    })
  })
})
