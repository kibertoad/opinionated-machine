import {
  type ApiContract,
  buildRequestPath,
  type HttpStatusCode,
  type HttpStatusCodeRange,
  type ResponsesByStatusCode,
  resolveResponseEntry,
} from '@lokalise/api-contracts'
import {
  createSSEStreamParser,
  type ParsedSSEEvent,
  parseSSEEvents,
} from '@opinionated-machine/sse-parser'
import type { LightMyRequestResponse } from 'fastify'
import type { z } from 'zod'
import {
  describeSendFailures,
  openSSEDiagnosticsScope,
  type SSEDiagnosticsScope,
  type SSESendFailure,
  unhandledSendFailures,
} from '../sse/sseSendDiagnostics.ts'
import type { AnyFastifyInstance } from './AnyFastifyInstance.ts'
import {
  assertSSEResponse,
  mediaTypeOf,
  resolveApiSseSchemas,
  SSE_CONTENT_TYPE,
  validateApiSseEvent,
} from './apiSseEventValidation.ts'
import type {
  ApiDeclaredResponseBody,
  ApiDeclaredResponseStatus,
  ApiSSEEventReader,
  ApiSSEStreamReader,
  InjectApiSSEParams,
  InjectApiSSEResult,
} from './apiSseTestTypes.ts'
import { truncateBody } from './sseInjectShared.ts'
import type { SSEInjectMethod, SSEResponse, SSEResponseHead } from './sseTestTypes.ts'

/**
 * Methods whose contracts can declare a request body.
 *
 * Exactly the methods of `PayloadApiContract`; `GetApiContract` and `DeleteApiContract` type
 * `requestBodySchema` as `never`, so no contract can declare a body for any other verb.
 */
const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH'])

/** Read a response header that light-my-request may expose as an array. */
function readHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

const STATUS_RANGE_KEYS: readonly HttpStatusCodeRange[] = ['1xx', '2xx', '3xx', '4xx', '5xx']

/**
 * The `responsesByStatusCode` key that serves a status, following the same
 * exact → range → `'default'` precedence as `resolveResponseEntry`.
 *
 * Diagnostics only. `resolveResponseEntry` collapses "no entry for this status" and "an entry
 * exists but none of its content-map descriptors matched the response's content-type" into a
 * single `null`; this tells the two apart so the error names the actual problem.
 */
function findResponseKeyForStatus(
  responsesByStatusCode: ResponsesByStatusCode,
  statusCode: number,
): string | undefined {
  if (responsesByStatusCode[statusCode as HttpStatusCode]) {
    return String(statusCode)
  }
  const rangeKey = STATUS_RANGE_KEYS[Math.floor(statusCode / 100) - 1]
  if (rangeKey && responsesByStatusCode[rangeKey]) {
    return rangeKey
  }
  return responsesByStatusCode.default ? 'default' : undefined
}

/**
 * The JSON schema the contract declares for the status a response actually carries, or a
 * thrown error naming why there isn't one.
 *
 * Resolution follows the same exact → range → `'default'` precedence (and content-type
 * matching) the contract client uses, so a stream on one status and JSON bodies on the others
 * resolve independently.
 */
function resolveJsonSchemaForStatus(
  responsesByStatusCode: ResponsesByStatusCode,
  statusCode: number,
  res: SSEResponse,
): z.ZodType {
  const contentType = readHeader(res.headers['content-type'])
  // Non-strict resolution: a response without a content-type still resolves to the entry's
  // declared kind, which keeps hand-rolled test handlers working.
  const resolved = resolveResponseEntry(responsesByStatusCode, statusCode, contentType, false)

  if (!resolved) {
    const declaredKey = findResponseKeyForStatus(responsesByStatusCode, statusCode)
    throw new Error(
      declaredKey === undefined
        ? `bodyForStatus(${statusCode}) — no response declared for status ${statusCode} in contract.responsesByStatusCode`
        : `bodyForStatus(${statusCode}) — the '${declaredKey}' entry of contract.responsesByStatusCode declares no body for content-type '${mediaTypeOf(contentType) ?? 'absent'}'; body: ${truncateBody(res.body)}`,
    )
  }

  if (resolved.kind !== 'json') {
    // A dual-mode status lands here: `injectApiSSE` asks for the stream, so that is what the
    // status resolved to. The type layer rules this out, so reaching it means a cast.
    const hint =
      resolved.kind === 'sse'
        ? ` — injectApiSSE requests '${SSE_CONTENT_TYPE}', so a status declaring a stream always answers with it; read it with events()`
        : ''
    throw new Error(
      `bodyForStatus(${statusCode}) — the contract declares a '${resolved.kind}' response for status ${statusCode}, not a JSON body${hint}`,
    )
  }

  return resolved.schema
}

/** JSON-parse and schema-validate a response body, reporting either failure in context. */
function parseJsonBody(schema: z.ZodType, statusCode: number, body: string): unknown {
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(body)
  } catch (err) {
    throw new Error(
      `bodyForStatus(${statusCode}) — body is not valid JSON: ${(err as Error).message}; body: ${truncateBody(body)}`,
    )
  }

  const parsed = schema.safeParse(parsedJson)
  if (!parsed.success) {
    throw new Error(
      `bodyForStatus(${statusCode}) — body does not match the declared schema: ${parsed.error.message}; body: ${truncateBody(body)}`,
    )
  }
  return parsed.data
}

/**
 * Build a `bodyForStatus` accessor bound to one `injectApiSSE` call.
 *
 * @internal Exported only for unit testing — not part of the public API
 * (the testing barrel re-exports `injectApiSSE` by name).
 */
export function bindApiBodyForStatus<Contract extends ApiContract>(
  contract: Contract,
  closed: Promise<SSEResponse>,
): InjectApiSSEResult<Contract>['bodyForStatus'] {
  // A generic arrow function can't be assigned directly to the generic method signature,
  // so the whole closure is cast once. Keep in sync with `InjectApiSSEResult['bodyForStatus']`.
  return (async <Status extends ApiDeclaredResponseStatus<Contract>>(
    statusCode: Status,
  ): Promise<ApiDeclaredResponseBody<Contract, Status>> => {
    const res = await closed
    const expected: number = statusCode
    if (res.statusCode !== expected) {
      throw new Error(
        `bodyForStatus(${expected}) — actual status ${res.statusCode}, body: ${truncateBody(res.body)}`,
      )
    }

    const schema = resolveJsonSchemaForStatus(contract.responsesByStatusCode, expected, res)
    return parseJsonBody(schema, expected, res.body) as ApiDeclaredResponseBody<Contract, Status>
  }) as InjectApiSSEResult<Contract>['bodyForStatus']
}

/** Reject a response that is not an event stream, naming the reader that asked for one. */
function assertSSEHead(head: SSEResponseHead, reader: string, body?: string): void {
  assertSSEResponse(head.statusCode, readHeader(head.headers['content-type']), reader, body)
}

/**
 * Build an `events` accessor bound to one `injectApiSSE` call: parses the SSE body and
 * validates every event against the contract's `sseBody` schemas.
 *
 * @internal Exported only for unit testing — not part of the public API.
 */
export function bindApiEvents<Contract extends ApiContract>(
  contract: Contract,
  closed: Promise<SSEResponse>,
): ApiSSEEventReader<Contract> {
  return async () => {
    const res = await closed
    // Merges the SSE schemas of every declared status, not just the successful ones.
    const schemaByEventName = resolveApiSseSchemas(contract, 'events()')
    assertSSEHead(res, 'events()', res.body)
    return parseSSEEvents(res.body).map((event) =>
      validateApiSseEvent<Contract>(schemaByEventName, event, 'events()'),
    )
  }
}

/**
 * Consumes an injected SSE response as it is written, so events can be read while the handler
 * is still running and the completed body is still available afterwards.
 *
 * Fastify's `inject({ payloadAsStream: true })` resolves as soon as the response head is on
 * the wire — for a streaming handler, at `sse.start()` — and exposes the payload as a
 * `Readable` that receives every write. This pump drains it eagerly (so a slow or absent
 * consumer never blocks the handler), keeping both the parsed events seen so far and the raw
 * body text, and wakes any generator waiting on more.
 */
class InjectedSSEStream {
  /** Head of the response, available before the handler finished streaming. */
  readonly head: Promise<SSEResponseHead>
  /** Full response, once the stream ended. */
  readonly closed: Promise<SSEResponse>

  private readonly received: ParsedSSEEvent[] = []
  private waiters: Array<() => void> = []
  private ended = false
  private failure: unknown

  constructor(injected: Promise<LightMyRequestResponse>) {
    this.head = injected.then((res) => ({
      statusCode: res.statusCode,
      headers: res.headers as Record<string, string | string[] | undefined>,
    }))
    this.closed = this.drain(injected)

    // The pump owns both promises from the moment the request is injected; a caller reading
    // only one of them (or neither, for a request it expects to fail) must not turn the other
    // into an unhandled rejection. Awaiting either still rejects as usual.
    this.head.catch(() => {})
    this.closed.catch(() => {})
  }

  private async drain(injected: Promise<LightMyRequestResponse>): Promise<SSEResponse> {
    let res: LightMyRequestResponse
    try {
      res = await injected
    } catch (err) {
      this.fail(err)
      throw err
    }

    let body = ''
    const decoder = new TextDecoder()
    // Owns the partial frame across chunks, so a frame split by a flush boundary
    // is not read as two.
    const parser = createSSEStreamParser()
    try {
      for await (const chunk of res.stream()) {
        const text =
          typeof chunk === 'string' ? chunk : decoder.decode(chunk as Uint8Array, { stream: true })
        body += text
        const events = parser.push(text)
        if (events.length > 0) {
          this.received.push(...events)
          this.notify()
        }
      }
    } catch (err) {
      this.fail(err)
      throw err
    }

    // Anything still buffered is a frame the response ended in the middle of. The spec
    // discards pending data at the end of a stream, so it is not delivered as an event:
    // a truncated payload reported as a real one hides the handler bug that produced it.
    // The raw text is still on `body` for a test that wants to look.

    this.ended = true
    this.notify()

    return {
      statusCode: res.statusCode,
      headers: res.headers as Record<string, string | string[] | undefined>,
      body,
    }
  }

  private fail(err: unknown): void {
    this.failure = err
    this.ended = true
    this.notify()
  }

  private notify(): void {
    const waiters = this.waiters
    this.waiters = []
    for (const wake of waiters) {
      wake()
    }
  }

  /** Resolve once more events arrived, the stream ended, or the caller aborted. */
  private nextTick(signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false
      const wake = () => {
        if (settled) {
          return
        }
        settled = true
        signal?.removeEventListener('abort', wake)
        resolve()
      }
      this.waiters.push(wake)
      signal?.addEventListener('abort', wake, { once: true })
    })
  }

  /**
   * Yield every event of the stream, from the first one, waiting for more while the handler
   * is still writing. Replayable: each call starts from the beginning of the stream.
   */
  async *events(signal?: AbortSignal): AsyncGenerator<ParsedSSEEvent, void, unknown> {
    let index = 0
    while (true) {
      if (signal?.aborted) {
        return
      }
      while (index < this.received.length) {
        // biome-ignore lint/style/noNonNullAssertion: index is bounded by the array length
        yield this.received[index++]!
        if (signal?.aborted) {
          return
        }
      }
      if (this.failure) {
        throw this.failure
      }
      if (this.ended) {
        return
      }
      await this.nextTick(signal)
    }
  }
}

/**
 * Throw the sends the route could not make and did not recover from, if any were recorded for
 * this request.
 *
 * A payload that fails the contract's schema for its event makes `session.send()` throw
 * inside the handler; the event never reaches the wire and the reason only reaches the server
 * log. Reading the stream through these helpers surfaces it here instead, so the test fails
 * on the event that was never sent rather than on the next one it did receive.
 */
function assertNoSendFailures(scope: SSEDiagnosticsScope, reader: string): void {
  // A failure the route caught and streamed around is context, not a verdict: the response
  // the test read is the one the route meant to produce. Only the failures that truncated it
  // explain a missing event, so only those fail the read — the rest stay on `sendFailures()`.
  const failures = unhandledSendFailures(scope.failures())
  if (failures.length > 0) {
    throw new Error(`${reader} — ${describeSendFailures(failures)}`)
  }
}

/**
 * Inject an SSE request using a contract built with `defineApiContract` + `sseResponse` /
 * `sseBody` (the newer `@lokalise/api-contracts` API).
 *
 * The `defineApiContract` counterpart of `injectSSE` / `injectPayloadSSE`, which are typed
 * against the legacy `SSEContractDefinition`. One function covers every method: the HTTP verb
 * comes from the contract, and `params` (`pathParams` / `queryParams` / `headers` / `body` /
 * `pathPrefix`) is the same shape `injectByApiContract` takes, so a body is required exactly
 * when the contract declares `requestBodySchema`.
 *
 * The request always carries `accept: text/event-stream` (a caller-supplied `accept` still
 * wins), so a status declaring a stream answers with it — dual-mode statuses included. Those
 * statuses expose no JSON body through `bodyForStatus`; read them with `events()`, or use
 * `injectByApiContract` when you want the JSON side.
 *
 * The response is injected as a stream, so `head` resolves as soon as the handler starts
 * streaming and `stream()` yields each event as it is written — a test can assert
 * progressive delivery without a listening server. `closed` and `events()` still wait for
 * the response to complete, so an endpoint that never closes its stream (a `keepAlive`
 * session) can only be read through `stream()`; use `SSEHttpClient` / `connectApiSSE`
 * against a real server for those.
 *
 * @param app - Fastify instance
 * @param contract - Contract built with `defineApiContract`
 * @param params - Request params derived from the contract
 *
 * @example
 * ```typescript
 * const { closed, bodyForStatus, events } = injectApiSSE(app, lqaTextSegmentContract, {
 *   body: { segment: 'hello' },
 * })
 *
 * // Typed events, validated against the contract's sseResponse schemas
 * for (const event of await events()) {
 *   if (event.event === 'review') expect(event.data.score).toBeGreaterThan(0)
 * }
 *
 * // Or the raw body, for assertions the typed accessors don't cover
 * expect((await closed).statusCode).toBe(200)
 * ```
 *
 * @example
 * ```typescript
 * // Progressive delivery: each event is observed while the handler is still working
 * const { head, stream } = injectApiSSE(app, lqaTextSegmentContract, { body: { segment } })
 * expect((await head).statusCode).toBe(200)
 *
 * for await (const event of stream()) {
 *   if (event.event === 'issue') expect(handlerFinished).toBe(false)
 * }
 * ```
 *
 * @example
 * ```typescript
 * // A documented pre-stream error response, typed by the contract's 400 schema
 * const { bodyForStatus } = injectApiSSE(app, lqaTextSegmentContract, { body: { segment: '' } })
 * const error = await bodyForStatus(400)
 * expect(error.message).toBe('segment must not be empty')
 * ```
 */
export function injectApiSSE<const Contract extends ApiContract>(
  app: AnyFastifyInstance,
  contract: Contract,
  params: InjectApiSSEParams<Contract>,
): InjectApiSSEResult<Contract> {
  // biome-ignore lint/suspicious/noExplicitAny: params shape depends on the contract
  const requestParams = params as any
  const method = contract.method.toUpperCase() as SSEInjectMethod
  const url = buildRequestPath(
    contract.pathResolver(requestParams.pathParams),
    requestParams.pathPrefix,
  )

  // Records the sends the handler could not make (a payload that failed its event schema),
  // matched to this request by a header the route builder honours only for open scopes.
  const scope = openSSEDiagnosticsScope()

  const injected = (async () => {
    // `headers` may be a factory, exactly as `injectByApiContract` accepts it.
    const callerHeaders =
      typeof requestParams.headers === 'function'
        ? await requestParams.headers()
        : requestParams.headers

    return app.inject({
      method,
      url,
      // `accept` first so an explicit caller header still wins; the diagnostics header last,
      // since it addresses this call's scope and nothing else may claim it.
      headers: { accept: SSE_CONTENT_TYPE, ...callerHeaders, ...scope.headers },
      ...(requestParams.queryParams !== undefined && { query: requestParams.queryParams }),
      ...(METHODS_WITH_BODY.has(method) && { payload: requestParams.body }),
      payloadAsStream: true,
    })
  })()

  const pump = new InjectedSSEStream(injected)
  const { head, closed } = pump

  // Failures are only complete once the response is, and the scope must not outlive the
  // request either way; disposing snapshots what was recorded, so the readers below still
  // report it afterwards.
  void closed.then(
    () => scope.dispose(),
    () => scope.dispose(),
  )

  const bufferedEvents = bindApiEvents(contract, closed)

  const events: ApiSSEEventReader<Contract> = async () => {
    await closed
    assertNoSendFailures(scope, 'events()')
    return bufferedEvents()
  }

  const stream: ApiSSEStreamReader<Contract> = async function* (signal?: AbortSignal) {
    const schemaByEventName = resolveApiSseSchemas(contract, 'stream()')
    assertSSEHead(await head, 'stream()')

    for await (const event of pump.events(signal)) {
      yield validateApiSseEvent<Contract>(schemaByEventName, event, 'stream()')
    }

    if (!signal?.aborted) {
      // The stream ended: anything the handler failed to send is known now, and is the
      // reason an expected event never arrived.
      assertNoSendFailures(scope, 'stream()')
    }
  }

  return {
    closed,
    head,
    sendFailures: (): SSESendFailure[] => scope.failures(),
    bodyForStatus: bindApiBodyForStatus(contract, closed),
    // `events` / `stream` are typed `never` for contracts that declare no SSE response, which
    // no concrete function satisfies — the callable forms are narrowed here.
    events: events as InjectApiSSEResult<Contract>['events'],
    stream: stream as InjectApiSSEResult<Contract>['stream'],
  }
}
