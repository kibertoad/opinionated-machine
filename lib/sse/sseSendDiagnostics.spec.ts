import type { SSESession } from '@lokalise/fastify-api-contracts'
import type { RouteHandlerMethod } from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  attachSSESendDiagnostics,
  describeSendFailures,
  openSSEDiagnosticsScope,
  reportSSEHandlerOutcome,
  SSE_DIAGNOSTICS_HEADER,
  type SSESendFailure,
  unhandledSendFailures,
} from './sseSendDiagnostics.ts'

const eventSchemas = { issue: z.object({ severity: z.enum(['minor', 'major']) }) }

/**
 * A stand-in for the session `sse.start()` hands to a handler: `send` throws for a payload
 * that fails its event schema, exactly as the contracts package's session does.
 */
function fakeSession(headers: Record<string, string | string[] | undefined>) {
  const sent: Array<{ event: string; data: unknown }> = []

  // biome-ignore lint/suspicious/useAwait: mirrors the async `send` of a real session
  const send = async (eventName: string, data: unknown) => {
    const schema = eventSchemas[eventName as keyof typeof eventSchemas]
    const result = schema?.safeParse(data)
    if (result && !result.success) {
      throw new Error(
        `SSE event validation failed for event "${eventName}": ${result.error.message}`,
      )
    }
    sent.push({ event: eventName, data })
    return true
  }

  const session = {
    request: { headers },
    send,
    sendStream: async (messages: AsyncIterable<{ event: string; data: unknown }>) => {
      for await (const message of messages) {
        await send(message.event, message.data)
      }
    },
  }

  // Only the three members the instrumentation touches are modelled; the rest of a real
  // session plays no part in it.
  return { sent, session, asSession: session as unknown as SSESession }
}

describe('sseSendDiagnostics', () => {
  it('records the event name, payload and Zod issues of a failed send', async () => {
    const scope = openSSEDiagnosticsScope()
    const { session, asSession } = fakeSession(scope.headers)
    attachSSESendDiagnostics(asSession, eventSchemas)

    // The instrumentation observes the failure; the handler still sees it thrown.
    await expect(session.send('issue', { severity: 'min' })).rejects.toThrow(/validation failed/)

    expect(scope.failures()).toMatchObject([
      {
        eventName: 'issue',
        data: { severity: 'min' },
        issues: [{ path: ['severity'] }],
      },
    ])
    scope.dispose()
  })

  it('names the message a sendStream failed on', async () => {
    const scope = openSSEDiagnosticsScope()
    const { session, sent, asSession } = fakeSession(scope.headers)
    attachSSESendDiagnostics(asSession, eventSchemas)

    // biome-ignore lint/suspicious/useAwait: async generator required for AsyncIterable
    async function* messages() {
      yield { event: 'issue', data: { severity: 'minor' } }
      yield { event: 'issue', data: { severity: 'nope' } }
    }

    await expect(session.sendStream(messages())).rejects.toThrow(/validation failed/)

    expect(sent).toEqual([{ event: 'issue', data: { severity: 'minor' } }])
    expect(scope.failures()).toMatchObject([{ eventName: 'issue', data: { severity: 'nope' } }])
    scope.dispose()
  })

  it('leaves a session alone when the request names no open scope', async () => {
    const scope = openSSEDiagnosticsScope()
    scope.dispose()

    const { session, asSession } = fakeSession({ [SSE_DIAGNOSTICS_HEADER]: scope.id })
    const originalSend = session.send
    attachSSESendDiagnostics(asSession, eventSchemas)

    // A stale (or forged) header must not make a server record anything.
    expect(session.send).toBe(originalSend)
    await expect(session.send('issue', { severity: 'min' })).rejects.toThrow()
    expect(scope.failures()).toEqual([])
  })

  it('ignores a request without the header while another scope is open', async () => {
    const scope = openSSEDiagnosticsScope()
    const { session, asSession } = fakeSession({})
    const originalSend = session.send

    attachSSESendDiagnostics(asSession, eventSchemas)

    expect(session.send).toBe(originalSend)
    await expect(session.send('issue', { severity: 'min' })).rejects.toThrow()
    expect(scope.failures()).toEqual([])
    scope.dispose()
  })

  it('keeps the failures recorded before dispose, and nothing after it', async () => {
    const scope = openSSEDiagnosticsScope()
    const { session, asSession } = fakeSession(scope.headers)
    attachSSESendDiagnostics(asSession, eventSchemas)

    await expect(session.send('issue', { severity: 'min' })).rejects.toThrow()
    scope.dispose()
    scope.dispose() // idempotent

    await expect(session.send('issue', { severity: 'nope' })).rejects.toThrow()

    expect(scope.failures()).toHaveLength(1)
  })

  it('reports a failure that is not a validation error without inventing issues', async () => {
    const scope = openSSEDiagnosticsScope()
    const { session, asSession } = fakeSession(scope.headers)
    // A schema map without the event: nothing to re-validate against.
    attachSSESendDiagnostics(asSession, {})

    await expect(session.send('issue', { severity: 'min' })).rejects.toThrow()

    const [failure] = scope.failures()
    expect(failure?.issues).toBeUndefined()
    expect(failure?.message).toMatch(/validation failed/)
    scope.dispose()
  })

  it('attributes a sendStream failure to the source when the source is what threw', async () => {
    const scope = openSSEDiagnosticsScope()
    const { session, sent, asSession } = fakeSession(scope.headers)
    attachSSESendDiagnostics(asSession, eventSchemas)

    // biome-ignore lint/suspicious/useAwait: async generator required for AsyncIterable
    async function* messages() {
      yield { event: 'issue', data: { severity: 'minor' } }
      throw new Error('upstream LLM died')
    }

    await expect(session.sendStream(messages())).rejects.toThrow('upstream LLM died')

    // The last message was sent, and is on the wire — blaming it would point at the one event
    // the test can actually see.
    expect(sent).toEqual([{ event: 'issue', data: { severity: 'minor' } }])
    expect(scope.failures()).toMatchObject([{ message: 'upstream LLM died', handled: false }])
    // No event was in flight, so none is blamed.
    expect(scope.failures()[0]?.eventName).toBeUndefined()
    expect(describeSendFailures(scope.failures())).toContain(
      'the sendStream() source threw before the next event: upstream LLM died',
    )
    scope.dispose()
  })

  describe('handler outcome', () => {
    /** Run `handler` through the route instrumentation, as `buildApiRoute` wires it. */
    const runHandler = (scopeHeaders: Record<string, string>, handler: () => unknown) => {
      // Only `request.headers` is read, so a minimal request stands in for a Fastify one.
      const instrumented = reportSSEHandlerOutcome(handler as unknown as RouteHandlerMethod)
      return (instrumented as (request: unknown, reply: unknown) => Promise<unknown>)(
        { headers: scopeHeaders },
        {},
      )
    }

    it('marks a failure the handler caught as handled', async () => {
      const scope = openSSEDiagnosticsScope()
      const { session, asSession } = fakeSession(scope.headers)
      attachSSESendDiagnostics(asSession, eventSchemas)

      await runHandler(scope.headers, async () => {
        // A best-effort send the handler recovers from: the response it goes on to write is
        // the one it meant to write.
        await session.send('issue', { severity: 'min' }).catch(() => {})
        await session.send('issue', { severity: 'minor' })
      })

      expect(scope.failures()).toMatchObject([{ eventName: 'issue', handled: true }])
      expect(unhandledSendFailures(scope.failures())).toEqual([])
      scope.dispose()
    })

    it('leaves a failure the handler let escape unhandled', async () => {
      const scope = openSSEDiagnosticsScope()
      const { session, asSession } = fakeSession(scope.headers)
      attachSSESendDiagnostics(asSession, eventSchemas)

      await expect(
        runHandler(scope.headers, () => session.send('issue', { severity: 'min' })),
      ).rejects.toThrow(/validation failed/)

      expect(unhandledSendFailures(scope.failures())).toMatchObject([
        { eventName: 'issue', handled: false },
      ])
      scope.dispose()
    })

    it('follows the cause chain of an error the handler rethrew wrapped', async () => {
      const scope = openSSEDiagnosticsScope()
      const { session, asSession } = fakeSession(scope.headers)
      attachSSESendDiagnostics(asSession, eventSchemas)

      await expect(
        runHandler(scope.headers, async () => {
          try {
            await session.send('issue', { severity: 'min' })
          } catch (cause) {
            throw new Error('streaming the review failed', { cause })
          }
        }),
      ).rejects.toThrow('streaming the review failed')

      expect(unhandledSendFailures(scope.failures())).toHaveLength(1)
      scope.dispose()
    })

    it('marks caught failures handled while leaving the escaping one unhandled', async () => {
      const scope = openSSEDiagnosticsScope()
      const { session, asSession } = fakeSession(scope.headers)
      attachSSESendDiagnostics(asSession, eventSchemas)

      await expect(
        runHandler(scope.headers, async () => {
          await session.send('issue', { severity: 'min' }).catch(() => {})
          await session.send('issue', { severity: 'nope' })
        }),
      ).rejects.toThrow(/validation failed/)

      expect(scope.failures().map((failure) => failure.handled)).toEqual([true, false])
      expect(unhandledSendFailures(scope.failures())).toMatchObject([
        { data: { severity: 'nope' } },
      ])
      scope.dispose()
    })

    it('does nothing for a request that names no open scope', async () => {
      const scope = openSSEDiagnosticsScope()
      const handler = vi.fn(() => Promise.resolve('done'))

      await expect(runHandler({}, handler)).resolves.toBe('done')

      expect(handler).toHaveBeenCalledTimes(1)
      scope.dispose()
    })
  })

  it('renders one line per failure, saying what was rejected and what recovered', () => {
    const failures: SSESendFailure[] = [
      {
        eventName: 'issue',
        data: { severity: 'min' },
        message: 'boom',
        issues: [
          {
            code: 'invalid_value',
            path: ['severity'],
            message: 'Invalid option',
          } as never,
        ],
        error: new Error('boom'),
        handled: false,
      },
      {
        eventName: 'review',
        data: undefined,
        message: 'connection closed',
        error: new Error('connection closed'),
        handled: true,
      },
      {
        message: 'upstream LLM died',
        error: new Error('upstream LLM died'),
        handled: false,
      },
    ]

    expect(describeSendFailures(failures)).toBe(
      '3 SSE send failures recorded for this request:\n' +
        '  - event "issue" was never sent: severity: Invalid option; payload: {"severity":"min"}\n' +
        '  - event "review" was never sent: connection closed; payload: undefined' +
        ' (caught by the route, which completed the response)\n' +
        '  - the sendStream() source threw before the next event: upstream LLM died',
    )
  })

  it('renders a single failure in the singular', () => {
    expect(
      describeSendFailures([
        { eventName: 'issue', data: 1, message: 'boom', error: new Error('boom'), handled: false },
      ]),
    ).toBe(
      '1 SSE send failure recorded for this request:\n' +
        '  - event "issue" was never sent: boom; payload: 1',
    )
  })
})
