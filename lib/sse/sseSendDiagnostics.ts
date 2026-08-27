import type { IncomingHttpHeaders } from 'node:http'
import type { SSEEventSchemas } from '@lokalise/api-contracts'
import type { SSESession } from '@lokalise/fastify-api-contracts'
import type { RouteHandlerMethod } from 'fastify'
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
  /**
   * Name of the event the handler tried to send.
   *
   * Absent when the failure came from the message source of `sendStream()` rather than from
   * a send: the source threw while producing the next message, so no event was in flight.
   */
  eventName?: string
  /** Payload the handler passed, as-is. Absent together with {@link eventName}. */
  data?: unknown
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
  /**
   * Whether the route recovered from this failure.
   *
   * `true` when the handler caught the error and went on to complete the response — the
   * stream the test read is the one the route meant to produce, so the failure is context,
   * not a verdict. `false` when the error escaped the handler (or was raised after it
   * returned, on a `keepAlive` session): nothing recovered, and the stream ended where the
   * send failed.
   *
   * Only final once the response completed; the test helpers only read it then.
   */
  handled: boolean
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

/** How far to walk an error's `cause` chain when matching it to a recorded failure. */
const MAX_CAUSE_DEPTH = 10

/**
 * The failures of one observed request, plus whether the route recovered from them.
 *
 * Split from {@link SSEDiagnosticsScope} because the two ends see different things: the scope
 * is the reader's handle (it can only snapshot and unregister), while the recorder is what the
 * instrumented route writes to.
 */
class SSEDiagnosticsRecorder {
  readonly failures: SSESendFailure[] = []
  private settled = false

  /** Record a send that threw, and the Zod issues behind it when the payload explains it. */
  recordSendFailure(
    schemaByEventName: SSEEventSchemas,
    eventName: string,
    data: unknown,
    error: unknown,
  ): void {
    if (this.failures.length >= MAX_FAILURES_PER_SCOPE) {
      return
    }
    const issues = issuesFor(schemaByEventName, eventName, data)
    this.failures.push({
      eventName,
      data,
      message: messageOf(error),
      ...(issues && { issues }),
      error,
      handled: false,
    })
  }

  /** Record a `sendStream()` source that threw while producing its next message. */
  recordSourceFailure(error: unknown): void {
    if (this.failures.length >= MAX_FAILURES_PER_SCOPE) {
      return
    }
    this.failures.push({ message: messageOf(error), error, handled: false })
  }

  /**
   * The route handler settled: everything recorded so far that did not escape it was caught
   * by the route, which went on to produce the rest of the response.
   *
   * Called once per request, before the response ends, so the helpers reading the stream see
   * final `handled` flags. Failures recorded afterwards — a send on a `keepAlive` session the
   * handler already returned from — stay unhandled: nothing observably recovered from them.
   *
   * @param escaped - The error the handler threw, if it threw
   */
  settle(escaped?: unknown): void {
    if (this.settled) {
      return
    }
    this.settled = true
    for (const failure of this.failures) {
      failure.handled = !causedBy(escaped, failure.error)
    }
  }
}

const openScopes = new Map<string, SSEDiagnosticsRecorder>()
let nextScopeId = 0

/**
 * Open a diagnostics scope for a single request.
 *
 * @internal Used by the SSE test helpers; tests reach the failures through the helper they
 * called, not through this registry.
 */
export function openSSEDiagnosticsScope(): SSEDiagnosticsScope {
  const id = `sse-diag-${++nextScopeId}`
  openScopes.set(id, new SSEDiagnosticsRecorder())

  let snapshot: SSESendFailure[] | undefined

  return {
    id,
    headers: { [SSE_DIAGNOSTICS_HEADER]: id },
    failures: () => snapshot ?? [...(openScopes.get(id)?.failures ?? [])],
    dispose: () => {
      if (!snapshot) {
        snapshot = [...(openScopes.get(id)?.failures ?? [])]
        openScopes.delete(id)
      }
    },
  }
}

/**
 * How many diagnostics scopes are registered right now.
 *
 * @internal Exists so the helpers' own specs can prove that every path out of a request
 * unregisters its scope: a leaked one keeps its records alive for the rest of the process and
 * costs every later request the fast path below.
 */
export function countOpenSSEDiagnosticsScopes(): number {
  return openScopes.size
}

/** The recorder a request writes to, or `undefined` when it belongs to no open scope. */
function resolveRecorder(headers: IncomingHttpHeaders): SSEDiagnosticsRecorder | undefined {
  // Fast path for production traffic: with no scope open the header can't match anything.
  if (openScopes.size === 0) {
    return undefined
  }
  const header = headers[SSE_DIAGNOSTICS_HEADER]
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Whether `error` is `candidate`, or was thrown wrapping it as a `cause`.
 *
 * A handler that rethrows the send error as-is is the common case; one that wraps it in its
 * own error still did not recover from it, so the chain is walked (to a bounded depth, since
 * a `cause` chain can be cyclic).
 */
function causedBy(error: unknown, candidate: unknown): boolean {
  let current = error
  for (
    let depth = 0;
    depth < MAX_CAUSE_DEPTH && current !== undefined && current !== null;
    depth++
  ) {
    if (current === candidate) {
      return true
    }
    current = current instanceof Error ? current.cause : undefined
  }
  return false
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
  const recorder = resolveRecorder(session.request.headers)
  if (!recorder) {
    return
  }

  const originalSend = session.send.bind(session)
  session.send = async (eventName, data, options) => {
    try {
      return await originalSend(eventName, data, options)
    } catch (error) {
      recorder.recordSendFailure(schemaByEventName, eventName, data, error)
      throw error
    }
  }

  const originalSendStream = session.sendStream.bind(session)
  session.sendStream = async (messages) => {
    // The send that throws happens inside `sendStream`, which reports neither the event name
    // nor the payload. Wrapping the source names it: `pending` holds the message handed to
    // the sender, and is cleared when the sender comes back for the next one — which only
    // happens once the previous send resolved. So a rejection with `pending` set is a failed
    // send of that message, and one without is the source itself throwing.
    let pending: { event: string; data: unknown } | undefined
    async function* tracked() {
      for await (const message of messages) {
        pending = message
        yield message
        pending = undefined
      }
    }

    try {
      await originalSendStream(tracked())
    } catch (error) {
      if (pending) {
        recorder.recordSendFailure(schemaByEventName, pending.event, pending.data, error)
      } else {
        recorder.recordSourceFailure(error)
      }
      throw error
    }
  }
}

/**
 * Wrap a route handler so the diagnostics scope learns whether the route recovered from the
 * sends it could not make.
 *
 * A send that throws is only a reason for a test to fail when nothing caught it: a handler
 * that catches its own failed send and streams a fallback instead produced exactly the
 * response it meant to. Observing how the handler settled is what tells the two apart —
 * {@link SSESendFailure.handled}.
 *
 * A no-op for requests that name no open diagnostics scope: outside a test run this is one
 * `Map.size` check per request on SSE routes.
 *
 * @internal Applied by `buildApiRoute` to SSE-capable routes.
 */
export function reportSSEHandlerOutcome(handler: RouteHandlerMethod): RouteHandlerMethod {
  const instrumented: RouteHandlerMethod = function instrumentedHandler(request, reply) {
    const recorder = resolveRecorder(request.headers)
    if (!recorder) {
      return handler.call(this, request, reply)
    }

    let result: unknown
    try {
      result = handler.call(this, request, reply)
    } catch (error) {
      // A handler that throws before returning a promise never opened a stream to recover in.
      recorder.settle(error)
      throw error
    }

    return Promise.resolve(result).then(
      (value) => {
        recorder.settle()
        // Whatever the wrapped handler resolves to is what Fastify sends: pass it through.
        return value
      },
      (error: unknown) => {
        recorder.settle(error)
        throw error
      },
    )
  }
  return instrumented
}

/**
 * The failures the route did not recover from — the ones that truncated the response, and so
 * explain an event a test waited for and never saw.
 *
 * @internal
 */
export function unhandledSendFailures(failures: SSESendFailure[]): SSESendFailure[] {
  return failures.filter((failure) => !failure.handled)
}

/**
 * Render recorded failures as the message of the error the test helpers throw.
 *
 * @internal
 */
export function describeSendFailures(failures: SSESendFailure[]): string {
  const lines = failures.map((failure) => `  - ${describeSendFailure(failure)}`)
  const subject = failures.length === 1 ? 'failure' : 'failures'
  return `${failures.length} SSE send ${subject} recorded for this request:\n${lines.join('\n')}`
}

function describeSendFailure(failure: SSESendFailure): string {
  const recovered = failure.handled ? ' (caught by the route, which completed the response)' : ''
  if (failure.eventName === undefined) {
    return `the sendStream() source threw before the next event: ${failure.message}${recovered}`
  }

  const detail = failure.issues
    ? failure.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')
    : failure.message
  return `event "${failure.eventName}" was never sent: ${detail}; payload: ${safeStringify(failure.data)}${recovered}`
}

/** JSON for an error message, degrading to `String()` for anything JSON can't take. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}
