import { afterEach, describe, expect, it } from 'vitest'
import { buildApiRoute, connectApiSSE, injectApiSSE, SSEInjectClient } from '../../index.js'
import type { SSETestServerWithResources } from '../sseTestServerFactory.ts'
import { startSSEStreamTestApp } from './fixtures/sseStreamTestApp.ts'
import { apiLqaIssueStreamContract } from './fixtures/testContracts.ts'

/**
 * A payload that fails the contract's schema for its event makes `session.send()` throw
 * inside the handler: the event never reaches the wire, the stream ends early with HTTP 200,
 * and the ZodError only shows up in the server log. A test reading the stream sees an event
 * missing — several hundred log lines away from the reason.
 *
 * The SSE test helpers tag their requests, so the routes built by `buildApiRoute` can report
 * what the handler failed to send back to the test that asked for the stream.
 */
describe('SSE send failures reach the test process', () => {
  let server: SSETestServerWithResources<undefined> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  /** A handler whose second event carries a severity the contract does not allow. */
  const registerFailingRoute = () =>
    startSSEStreamTestApp((app) => {
      app.route(
        buildApiRoute(apiLqaIssueStreamContract, async (_request, _reply, { sse }) => {
          const session = sse.start('autoClose')
          await session.send('issue', { severity: 'minor' })
          // A partially parsed LLM object: 'min' is not one of the declared severities.
          await session.send('issue', { severity: 'min' as 'minor' })
          await session.send('review', { score: 1 })
        }),
      )
    })

  it('fails events() with the offending event name and its validation issues', async () => {
    server = await registerFailingRoute()

    const { events } = injectApiSSE(server.app, apiLqaIssueStreamContract, {
      body: { segment: 'hello' },
    })

    await expect(events()).rejects.toThrow(
      /events\(\) — 1 SSE send failure recorded for this request:\n {2}- event "issue" was never sent: severity: Invalid option: expected one of "neutral"\|"minor"\|"major"\|"critical"; payload: \{"severity":"min"\}/,
    )
  })

  it('fails stream() the same way, once the stream ends short', async () => {
    server = await registerFailingRoute()

    const { stream } = injectApiSSE(server.app, apiLqaIssueStreamContract, {
      body: { segment: 'hello' },
    })

    const received: string[] = []
    await expect(async () => {
      for await (const event of stream()) {
        received.push(event.event)
      }
    }).rejects.toThrow(/stream\(\) — 1 SSE send failure recorded/)

    // The events that did make it are still delivered — only the tail is missing.
    expect(received).toEqual(['issue'])
  })

  it('explains a real-HTTP collection that ran out of events', async () => {
    server = await registerFailingRoute()

    const client = await connectApiSSE(server.baseUrl, apiLqaIssueStreamContract, {
      body: { segment: 'hello' },
    })

    try {
      // The `review` event never arrives, because the `issue` before it was never sent, so
      // the collection ends short — and says why.
      await expect(client.collectEvents((event) => event.event === 'review', 300)).rejects.toThrow(
        /collectEvents\(\) — 1 SSE send failure recorded for this request:\n {2}- event "issue" was never sent: severity: Invalid option/,
      )
      expect(client.sendFailures()).toMatchObject([
        { eventName: 'issue', data: { severity: 'min' } },
      ])
    } finally {
      client.close()
    }
  })

  it('fails a real-HTTP events() loop that ran out of events', async () => {
    server = await registerFailingRoute()

    const client = await connectApiSSE(server.baseUrl, apiLqaIssueStreamContract, {
      body: { segment: 'hello' },
    })

    try {
      const received: string[] = []
      await expect(async () => {
        for await (const event of client.events()) {
          received.push(event.event)
        }
      }).rejects.toThrow(/events\(\) — 1 SSE send failure recorded/)

      expect(received).toEqual(['issue'])
    } finally {
      client.close()
    }
  })

  it('reports a failure from the declarative streaming path too', async () => {
    server = await startSSEStreamTestApp((app) => {
      app.route(
        buildApiRoute(apiLqaIssueStreamContract, () => {
          // biome-ignore lint/suspicious/useAwait: async generator required for AsyncIterable
          async function* issues() {
            yield { event: 'issue' as const, data: { severity: 'minor' as const } }
            yield { event: 'issue' as const, data: { severity: 'min' as 'minor' } }
          }
          return { status: 200, body: issues() }
        }),
      )
    })

    const { events } = injectApiSSE(server.app, apiLqaIssueStreamContract, {
      body: { segment: 'hello' },
    })

    await expect(events()).rejects.toThrow(/event "issue" was never sent: severity: Invalid option/)
  })

  it('leaves a healthy stream alone', async () => {
    server = await startSSEStreamTestApp((app) => {
      app.route(
        buildApiRoute(apiLqaIssueStreamContract, async (_request, _reply, { sse }) => {
          const session = sse.start('autoClose')
          await session.send('issue', { severity: 'minor' })
          await session.send('review', { score: 1 })
        }),
      )
    })

    const { events, stream } = injectApiSSE(server.app, apiLqaIssueStreamContract, {
      body: { segment: 'hello' },
    })

    const streamed = []
    for await (const event of stream()) {
      streamed.push(event)
    }

    expect(streamed).toEqual([
      { event: 'issue', data: { severity: 'minor' } },
      { event: 'review', data: { score: 1 } },
    ])
    expect(await events()).toEqual(streamed)
  })

  describe('a failure the route recovered from', () => {
    /**
     * A handler whose first send is best-effort: it fails the contract's schema, the handler
     * catches it and streams a documented `issue` instead. The response is the one the route
     * meant to produce, so reading it must succeed.
     */
    const registerRecoveringRoute = () =>
      startSSEStreamTestApp((app) => {
        app.route(
          buildApiRoute(apiLqaIssueStreamContract, async (_request, _reply, { sse }) => {
            const session = sse.start('autoClose')
            try {
              await session.send('issue', { severity: 'min' as 'minor' })
            } catch {
              await session.send('issue', { severity: 'minor' })
            }
            await session.send('review', { score: 1 })
          }),
        )
      })

    it('leaves events() and stream() alone, and reports it on sendFailures()', async () => {
      server = await registerRecoveringRoute()

      const { events, stream, sendFailures, closed } = injectApiSSE(
        server.app,
        apiLqaIssueStreamContract,
        { body: { segment: 'hello' } },
      )

      const streamed = []
      for await (const event of stream()) {
        streamed.push(event)
      }

      expect(streamed).toEqual([
        { event: 'issue', data: { severity: 'minor' } },
        { event: 'review', data: { score: 1 } },
      ])
      expect(await events()).toEqual(streamed)

      await closed
      expect(sendFailures()).toMatchObject([
        { eventName: 'issue', data: { severity: 'min' }, handled: true },
      ])
    })

    it('leaves the real-HTTP readers alone too', async () => {
      server = await registerRecoveringRoute()

      const client = await connectApiSSE(server.baseUrl, apiLqaIssueStreamContract, {
        body: { segment: 'hello' },
      })

      try {
        const collected = await client.collectEvents((event) => event.event === 'review')
        expect(collected).toEqual([
          { event: 'issue', data: { severity: 'minor' } },
          { event: 'review', data: { score: 1 } },
        ])
        expect(client.sendFailures()).toMatchObject([{ eventName: 'issue', handled: true }])
      } finally {
        client.close()
      }
    })
  })

  it('blames the source, not the last delivered event, when a stream source throws', async () => {
    server = await startSSEStreamTestApp((app) => {
      app.route(
        buildApiRoute(apiLqaIssueStreamContract, async (_request, _reply, { sse }) => {
          const session = sse.start('autoClose')
          // biome-ignore lint/suspicious/useAwait: async generator required for AsyncIterable
          async function* issues() {
            yield { event: 'issue' as const, data: { severity: 'minor' as const } }
            throw new Error('upstream LLM died')
          }
          await session.sendStream(issues())
        }),
      )
    })

    const { events } = injectApiSSE(server.app, apiLqaIssueStreamContract, {
      body: { segment: 'hello' },
    })

    // The `issue` event is on the wire; naming it as "never sent" would send the test after
    // the one event it can actually see.
    await expect(events()).rejects.toThrow(
      /the sendStream\(\) source threw before the next event: upstream LLM died/,
    )
  })

  it('does not instrument requests that carry no diagnostics scope', async () => {
    server = await registerFailingRoute()

    // The same route, driven by a client that opens no scope: the stream still ends short,
    // exactly as it did before — nothing about the route's behavior changed.
    const conn = await new SSEInjectClient(server.app).connectWithBody(
      '/api/sse-stream/lqa-issues',
      { segment: 'hello' },
    )

    expect(conn.getStatusCode()).toBe(200)
    expect(conn.getReceivedEvents().map((event) => event.event)).toEqual(['issue'])
  })
})
