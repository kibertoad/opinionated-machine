import fastify from 'fastify'
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import { buildApiRoute, injectApiSSE } from '../../index.js'
import type { SSETestServerWithResources } from '../sseTestServerFactory.ts'
import { createHandlerGate, startSSEStreamTestApp } from './fixtures/sseStreamTestApp.ts'
import { apiLqaIssueStreamContract } from './fixtures/testContracts.ts'

/**
 * `stream()` — reading an injected SSE response as the handler writes it.
 *
 * `events()` can only show the finished list, so it can prove the order of events but not
 * that any of them reached the client while the handler was still working. These tests hold
 * the handler at a gate and assert on what the client already has.
 */
describe('injectApiSSE — stream()', () => {
  let server: SSETestServerWithResources<undefined> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('yields each event while the handler is still running', async () => {
    const gate = createHandlerGate()
    server = await startSSEStreamTestApp((app) => {
      app.route(
        buildApiRoute(apiLqaIssueStreamContract, async (_request, _reply, { sse }) => {
          const session = sse.start('autoClose')
          await session.send('issue', { severity: 'minor' })
          await gate.wait()
          await session.send('issue', { severity: 'critical' })
          await session.send('review', { score: 2 })
          gate.finish()
        }),
      )
    })

    const { stream } = injectApiSSE(server.app, apiLqaIssueStreamContract, {
      body: { segment: 'hello' },
    })

    const seen: string[] = []
    for await (const event of stream()) {
      if (seen.length === 0) {
        // The decisive assertion: the first event is on the wire while the handler is
        // parked at the gate, several events short of returning.
        expect(gate.isFinished()).toBe(false)
        gate.release()
      }
      seen.push(event.event)

      if (event.event === 'issue') {
        expectTypeOf(event.data).toEqualTypeOf<{
          severity: 'neutral' | 'minor' | 'major' | 'critical'
        }>()
      }
      if (event.event === 'review') {
        expectTypeOf(event.data).toEqualTypeOf<{ score: number }>()
      }
    }

    expect(seen).toEqual(['issue', 'issue', 'review'])
    expect(gate.isFinished()).toBe(true)
  })

  it('resolves head as soon as the handler starts streaming, long before closed', async () => {
    const gate = createHandlerGate()
    server = await startSSEStreamTestApp((app) => {
      app.route(
        buildApiRoute(apiLqaIssueStreamContract, async (_request, _reply, { sse }) => {
          const session = sse.start('autoClose')
          await session.send('issue', { severity: 'neutral' })
          await gate.wait()
          gate.finish()
        }),
      )
    })

    const { head, closed } = injectApiSSE(server.app, apiLqaIssueStreamContract, {
      body: { segment: 'hello' },
    })

    const response = await head
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/event-stream')
    expect(gate.isFinished()).toBe(false)

    gate.release()
    expect((await closed).body).toContain('event: issue')
  })

  it('replays the whole stream for a generator started after the response completed', async () => {
    server = await startSSEStreamTestApp((app) => {
      app.route(
        buildApiRoute(apiLqaIssueStreamContract, async (_request, _reply, { sse }) => {
          const session = sse.start('autoClose')
          await session.send('issue', { severity: 'major' })
          await session.send('review', { score: 1 })
        }),
      )
    })

    const { stream, closed, events } = injectApiSSE(server.app, apiLqaIssueStreamContract, {
      body: { segment: 'hello' },
    })

    await closed

    const first = []
    for await (const event of stream()) {
      first.push(event)
    }
    const second = []
    for await (const event of stream()) {
      second.push(event)
    }

    expect(first).toEqual([
      { event: 'issue', data: { severity: 'major' } },
      { event: 'review', data: { score: 1 } },
    ])
    // A late (or repeated) reader sees the same stream `events()` reports.
    expect(second).toEqual(first)
    expect(await events()).toEqual(first)
  })

  it('stops early without disturbing the buffered accessors', async () => {
    server = await startSSEStreamTestApp((app) => {
      app.route(
        buildApiRoute(apiLqaIssueStreamContract, async (_request, _reply, { sse }) => {
          const session = sse.start('autoClose')
          await session.send('issue', { severity: 'minor' })
          await session.send('issue', { severity: 'major' })
          await session.send('review', { score: 3 })
        }),
      )
    })

    const { stream, events } = injectApiSSE(server.app, apiLqaIssueStreamContract, {
      body: { segment: 'hello' },
    })

    for await (const event of stream()) {
      if (event.event === 'issue') {
        break
      }
    }

    expect((await events()).map((event) => event.event)).toEqual(['issue', 'issue', 'review'])
  })

  it('ends the generator when the caller aborts', async () => {
    const gate = createHandlerGate()
    server = await startSSEStreamTestApp((app) => {
      app.route(
        buildApiRoute(apiLqaIssueStreamContract, async (_request, _reply, { sse }) => {
          const session = sse.start('autoClose')
          await session.send('issue', { severity: 'minor' })
          await gate.wait()
          await session.send('review', { score: 4 })
          gate.finish()
        }),
      )
    })

    const { stream, closed } = injectApiSSE(server.app, apiLqaIssueStreamContract, {
      body: { segment: 'hello' },
    })

    const abortController = new AbortController()
    const collected = []
    // Without the abort this generator would block on the gated handler.
    for await (const event of stream(abortController.signal)) {
      collected.push(event)
      abortController.abort()
    }

    expect(collected).toEqual([{ event: 'issue', data: { severity: 'minor' } }])

    gate.release()
    await closed
  })

  it('propagates an injection failure to both head and stream()', async () => {
    const app = fastify()
    await app.ready()
    await app.close()

    const { head, closed, stream } = injectApiSSE(app, apiLqaIssueStreamContract, {
      body: { segment: 'hello' },
    })

    // The request never reaches a handler, so every accessor reports the same failure
    // instead of hanging or resolving with an empty stream.
    await expect(head).rejects.toThrow()
    await expect(closed).rejects.toThrow()
    await expect(async () => {
      for await (const _event of stream()) {
        // never reached
      }
    }).rejects.toThrow()
  })

  it('rejects a response that is not an event stream, naming the accessor to use instead', async () => {
    server = await startSSEStreamTestApp((app) => {
      app.route(
        buildApiRoute(apiLqaIssueStreamContract, (request) => {
          if (request.body.segment.length === 0) {
            return { status: 400, body: { message: 'segment must not be empty' } }
          }
          throw new Error('unreachable in this test')
        }),
      )
    })

    const { stream, bodyForStatus } = injectApiSSE(server.app, apiLqaIssueStreamContract, {
      body: { segment: '' },
    })

    await expect(async () => {
      for await (const _event of stream()) {
        // never reached — the response is JSON, not a stream
      }
    }).rejects.toThrow(/stream\(\) — response is not an SSE stream \(status 400/)

    // The documented error body is still readable, as it is without stream().
    expect(await bodyForStatus(400)).toEqual({ message: 'segment must not be empty' })
  })
})
