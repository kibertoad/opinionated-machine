import type { SSEEventSchemas } from '@lokalise/api-contracts'
import type { SSESession } from '@lokalise/fastify-api-contracts'
import type { z } from 'zod'

/**
 * Request header carrying the id of an open diagnostics scope.
 *
 * The SSE test helpers (`injectApiSSE`, `connectApiSSE`) set it on every request they make;
 * routes built with `buildApiRoute` honour it by instrumenting the session they hand to the
 * handler. A value that does not name a scope opened in this process is ignored, so the
 * header is inert outside a test run — a client cannot make a production server record
 * anything by sending it.
 */
export const SSE_DIAGNOSTICS_HEADER = 'x-om-sse-diagnostics-id'

/**
 * One `session.send()` / `session.sendStream()` call that threw.
 *
 * Almost always a payload that failed the contract's schema for that event: the send throws,
 * the event never reaches the wire, and the stream just ends early — so the event the test
 * asserts on is missing while the reason lives in the server log.
 */
export type SSESendFailure = {
  /** Name of the event the handler tried to send. */
  eventName: string
  /** Payload the handler passed, as-is. */
  data: unknown
  /** Message of the thrown error. */
  message: string
  /**
   * Zod issues from re-validating `data` against the contract's schema for `eventName`.
   * Absent when the contract declares no schema for the event, or when the send failed for
   * a reason other than validation (a dead connection, say).
   */
  issues?: z.core.$ZodIssue[]
  /** The thrown error itself, for assertions the fields above don't cover. */
  error: unknown
}

/**
 * A registered diagnostics scope: the header to send, and the failures recorded for it.
 *
 * Opened by the SSE test helpers, one per request they issue. Instrumented sessions match a
 * request to a scope by the {@link SSE_DIAGNOSTICS_HEADER} value.
 */
export type SSEDiagnosticsScope = {
  /** Scope id, as sent in {@link SSE_DIAGNOSTICS_HEADER}. */
  id: string
  /** Headers to merge into the request this scope observes. */
  headers: Record<string, string>
  /**
   * The failures recorded so far. After {@link SSEDiagnosticsScope.dispose}, the snapshot
   * taken at that moment — so a result object can still report them long after the response
   * completed, without keeping the scope registered.
   */
  failures(): SSESendFailure[]
  /**
   * Snapshot the failures and unregister the scope. Idempotent, and safe to call while a
   * response is still in flight (nothing recorded afterwards is kept).
   */
  dispose(): void
}

/** Cap per scope, so a handler failing in a loop can't grow the registry without bound. */
const MAX_FAILURES_PER_SCOPE = 50

const openScopes = new Map<string, SSESendFailure[]>()
let nextScopeId = 0

/**
 * Open a diagnostics scope for a single request.
 *
 * @internal Used by the SSE test helpers; tests reach the failures through the helper they
 * called, not through this registry.
 */
export function openSSEDiagnosticsScope(): SSEDiagnosticsScope {
  const id = `sse-diag-${++nextScopeId}`
  openScopes.set(id, [])

  let snapshot: SSESendFailure[] | undefined

  return {
    id,
    headers: { [SSE_DIAGNOSTICS_HEADER]: id },
    failures: () => snapshot ?? [...(openScopes.get(id) ?? [])],
    dispose: () => {
      if (!snapshot) {
        snapshot = [...(openScopes.get(id) ?? [])]
        openScopes.delete(id)
      }
    },
  }
}

/** The scope a request belongs to, or `undefined` when it belongs to none. */
function resolveScope(session: SSESession): SSESendFailure[] | undefined {
  // Fast path for production traffic: with no scope open the header can't match anything.
  if (openScopes.size === 0) {
    return undefined
  }
  const header = session.request.headers[SSE_DIAGNOSTICS_HEADER]
  const id = Array.isArray(header) ? header[0] : header
  return id === undefined ? undefined : openScopes.get(id)
}

/** Re-validate a payload to recover the structured issues the thrown error only carries as text. */
function issuesFor(
  schemaByEventName: SSEEventSchemas,
  eventName: string,
  data: unknown,
): z.core.$ZodIssue[] | undefined {
  const schema = schemaByEventName[eventName]
  if (!schema) {
    return undefined
  }
  const result = schema.safeParse(data)
  return result.success ? undefined : result.error.issues
}

function recordFailure(
  failures: SSESendFailure[],
  schemaByEventName: SSEEventSchemas,
  eventName: string,
  data: unknown,
  error: unknown,
): void {
  if (failures.length >= MAX_FAILURES_PER_SCOPE) {
    return
  }
  const issues = issuesFor(schemaByEventName, eventName, data)
  failures.push({
    eventName,
    data,
    message: error instanceof Error ? error.message : String(error),
    ...(issues && { issues }),
    error,
  })
}

/**
 * Instrument an SSE session so that failed sends are recorded against the diagnostics scope
 * the request names, then rethrown unchanged.
 *
 * A no-op unless the request carries {@link SSE_DIAGNOSTICS_HEADER} with the id of a scope
 * open in this process, which only the SSE test helpers ever produce.
 *
 * @param session - The session handed to the handler by `sse.start()`
 * @param schemaByEventName - The contract's merged SSE event schemas, used to recover the
 *   Zod issues behind a validation failure
 *
 * @internal Called by `buildApiRoute`; not part of the application-facing API.
 */
export function attachSSESendDiagnostics(
  session: SSESession,
  schemaByEventName: SSEEventSchemas,
): void {
  const failures = resolveScope(session)
  if (!failures) {
    return
  }

  const originalSend = session.send.bind(session)
  session.send = async (eventName, data, options) => {
    try {
      return await originalSend(eventName, data, options)
    } catch (error) {
      recordFailure(failures, schemaByEventName, eventName, data, error)
      throw error
    }
  }

  const originalSendStream = session.sendStream.bind(session)
  session.sendStream = async (messages) => {
    // The send that throws happens inside `sendStream`, which reports neither the event name
    // nor the payload — track the last message pulled from the source so the failure can.
    let lastMessage: { event: string; data: unknown } | undefined
    async function* tracked() {
      for await (const message of messages) {
        lastMessage = message
        yield message
      }
    }

    try {
      await originalSendStream(tracked())
    } catch (error) {
      if (lastMessage) {
        recordFailure(failures, schemaByEventName, lastMessage.event, lastMessage.data, error)
      }
      throw error
    }
  }
}

/**
 * Render recorded failures as the message of the error the test helpers throw.
 *
 * @internal
 */
export function describeSendFailures(failures: SSESendFailure[]): string {
  const lines = failures.map((failure) => {
    const detail = failure.issues
      ? failure.issues
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; ')
      : failure.message
    return `  - event "${failure.eventName}": ${detail}; payload: ${safeStringify(failure.data)}`
  })

  const subject = failures.length === 1 ? 'event was' : 'events were'
  return `${failures.length} SSE ${subject} never sent because the send threw:\n${lines.join('\n')}`
}

/** JSON for an error message, degrading to `String()` for anything JSON can't take. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}
