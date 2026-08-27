import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import { buildApiRoute, connectApiSSE, createSSESessionSpy, SSEHttpClient } from '../../index.js'
import type { SSETestServerWithResources } from '../sseTestServerFactory.ts'
import { createHandlerGate, startSSEStreamTestApp } from './fixtures/sseStreamTestApp.ts'
import { apiChannelFeedContract, apiLqaIssueStreamContract } from './fixtures/testContracts.ts'

/**
 * `connectApiSSE` — the real-HTTP path, read through the contract.
 *
 * Same events, same validation and same typing `injectApiSSE().events()` gives, so a suite
 * that needs a running server (keepAlive sessions, mid-stream assertions on the wire) does
 * not have to re-assert payload shapes by hand.
 */
describe('connectApiSSE', () => {
  let server: SSETestServerWithResources<undefined> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('resolves method, path and body from the contract and types the events', async () => {
    const gate = createHandlerGate()
    server = await startSSEStreamTestApp((app) => {
      app.route(
        buildApiRoute(apiLqaIssueStreamContract, async (request, _reply, { sse }) => {
          const session = sse.start('autoClose')
          await session.send('issue', { severity: 'minor' })
          await gate.wait()
          await session.send('review', { score: request.body.segment.length })
          gate.finish()
        }),
      )
    })

    // No path literal next to the contract, and no method: both come from the contract.
    const client = await connectApiSSE(server.baseUrl, apiLqaIssueStreamContract, {
      body: { segment: 'hello' },
    })

    try {
      // Headers are on the wire before the handler is done — the reason to use real HTTP.
      expect(client.response.status).toBe(200)
      expect(client.response.headers.get('content-type')).toContain('text/event-stream')
      expect(gate.isFinished()).toBe(false)

      const seen: string[] = []
      for await (const event of client.events()) {
        seen.push(event.event)
        if (event.event === 'issue') {
          expectTypeOf(event.data).toEqualTypeOf<{
            severity: 'neutral' | 'minor' | 'major' | 'critical'
          }>()
          expect(event.data.severity).toBe('minor')
          gate.release()
        }
        if (event.event === 'review') {
          expectTypeOf(event.data).toEqualTypeOf<{ score: number }>()
          expect(event.data.score).toBe(5)
          break
        }
      }
      expect(seen).toEqual(['issue', 'review'])
    } finally {
      client.close()
    }
  })

  it('collects typed events with a contract-narrowed predicate', async () => {
    server = await startSSEStreamTestApp((app) => {
      app.route(
        buildApiRoute(apiLqaIssueStreamContract, async (_request, _reply, { sse }) => {
          const session = sse.start('autoClose')
          await session.send('issue', { severity: 'major' })
          await session.send('issue', { severity: 'critical' })
          await session.send('review', { score: 7 })
        }),
      )
    })

    const client = await connectApiSSE(server.baseUrl, apiLqaIssueStreamContract, {
      body: { segment: 'hello' },
    })

    try {
      const events = await client.collectEvents((event) => event.event === 'review')

      expect(events).toEqual([
        { event: 'issue', data: { severity: 'major' } },
        { event: 'issue', data: { severity: 'critical' } },
        { event: 'review', data: { score: 7 } },
      ])
    } finally {
      client.close()
    }
  })

  it('resolves path params, query params and headers from the contract', async () => {
    server = await startSSEStreamTestApp((app) => {
      app.route(
        buildApiRoute(apiChannelFeedContract, async (request, _reply, { sse }) => {
          if (request.headers.authorization !== 'Bearer valid-token') {
            return { status: 401, body: { message: 'Unauthorized' } }
          }
          const session = sse.start('autoClose')
          await session.send('ping', {
            channelId: request.params.channelId,
            seq: request.query.since ?? 0,
          })
          return
        }),
      )
    })

    const client = await connectApiSSE(server.baseUrl, apiChannelFeedContract, {
      pathParams: { channelId: 'c-42' },
      queryParams: { since: 7 },
      headers: { authorization: 'Bearer valid-token' },
    })

    try {
      const events = await client.collectEvents(1)
      expect(events).toEqual([{ event: 'ping', data: { channelId: 'c-42', seq: 7 } }])
    } finally {
      client.close()
    }
  })

  it('waits for the server-side session of a keepAlive route and drives it from the test', async () => {
    const { spy, routeOptions } = createSSESessionSpy()
    server = await startSSEStreamTestApp((app) => {
      app.route(
        buildApiRoute(
          apiChannelFeedContract,
          (_request, _reply, { sse }) => {
            sse.start('keepAlive')
          },
          routeOptions,
        ),
      )
    })

    const { client, serverConnection } = await connectApiSSE(
      server.baseUrl,
      apiChannelFeedContract,
      {
        pathParams: { channelId: 'c-7' },
        queryParams: {},
        headers: { authorization: 'Bearer valid-token' },
      },
      { awaitServerConnection: { spy } },
    )

    try {
      await serverConnection.send('ping', { channelId: 'c-7', seq: 1 })
      await serverConnection.send('ping', { channelId: 'c-7', seq: 2 })

      const events = await client.collectEvents(2)
      expect(events).toEqual([
        { event: 'ping', data: { channelId: 'c-7', seq: 1 } },
        { event: 'ping', data: { channelId: 'c-7', seq: 2 } },
      ])
    } finally {
      client.close()
    }
  })

  it('rejects an event payload that does not match the contract schema', async () => {
    server = await startSSEStreamTestApp((app) => {
      // Hand-rolled route: `buildApiRoute` would never let a bad payload onto the wire.
      app.get('/api/sse-stream/channels/:channelId/feed', (_request, reply) => {
        reply.raw.writeHead(200, { 'content-type': 'text/event-stream' })
        reply.raw.write('event: ping\ndata: {"channelId":"c-1","seq":"not-a-number"}\n\n')
        reply.raw.end()
        reply.hijack()
      })
    })

    const client = await connectApiSSE(server.baseUrl, apiChannelFeedContract, {
      pathParams: { channelId: 'c-1' },
      queryParams: {},
      headers: { authorization: 'Bearer valid-token' },
    })

    try {
      await expect(client.collectEvents(1)).rejects.toThrow(
        /data of event "ping" does not match the declared schema/,
      )
    } finally {
      client.close()
    }
  })

  it('reads an already-open SSEHttpClient connection through a contract', async () => {
    server = await startSSEStreamTestApp((app) => {
      app.route(
        buildApiRoute(apiLqaIssueStreamContract, async (_request, _reply, { sse }) => {
          const session = sse.start('autoClose')
          await session.send('issue', { severity: 'neutral' })
          await session.send('review', { score: 9 })
        }),
      )
    })

    // The untyped entry point, then contract typing added on the reader side.
    const client = await SSEHttpClient.connect(server.baseUrl, '/api/sse-stream/lqa-issues', {
      method: 'POST',
      body: { segment: 'hello' },
    })

    try {
      const events = await client.collectApiEvents(apiLqaIssueStreamContract, 2)
      expect(events).toEqual([
        { event: 'issue', data: { severity: 'neutral' } },
        { event: 'review', data: { score: 9 } },
      ])
      const review = events[1]
      if (review?.event === 'review') {
        expectTypeOf(review.data).toEqualTypeOf<{ score: number }>()
      }
    } finally {
      client.close()
    }
  })
})
