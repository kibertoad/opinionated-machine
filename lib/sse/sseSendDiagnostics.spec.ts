import type { SSESession } from '@lokalise/fastify-api-contracts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  attachSSESendDiagnostics,
  describeSendFailures,
  openSSEDiagnosticsScope,
  SSE_DIAGNOSTICS_HEADER,
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

  it('renders one line per failure, with the payload that was rejected', () => {
    const message = describeSendFailures([
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
      },
      {
        eventName: 'review',
        data: undefined,
        message: 'connection closed',
        error: new Error('connection closed'),
      },
    ])

    expect(message).toBe(
      '2 SSE events were never sent because the send threw:\n' +
        '  - event "issue": severity: Invalid option; payload: {"severity":"min"}\n' +
        '  - event "review": connection closed; payload: undefined',
    )
  })
})
