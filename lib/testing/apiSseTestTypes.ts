import type {
  ApiContract,
  ClientErrorHttpStatusCode,
  ExpandStatusRangeKey,
  HttpStatusCode,
  HttpStatusCodeRange,
  InformationalHttpStatusCode,
  RedirectionHttpStatusCode,
  ServerErrorHttpStatusCode,
  SuccessfulHttpStatusCode,
} from '@lokalise/api-contracts'
import type { InjectByApiContractParams } from '@lokalise/fastify-api-contracts'
import type { z } from 'zod'
import type { SSESendFailure } from '../sse/sseSendDiagnostics.ts'
import type { SSEResponse, SSEResponseHead } from './sseTestTypes.ts'

/**
 * Request params for {@link injectApiSSE}, derived from a `defineApiContract` contract.
 *
 * Identical to the params of `injectByApiContract` from
 * `@lokalise/fastify-api-contracts` — `pathParams`, `body`, `queryParams` and
 * `headers` are each required only when the contract declares the matching
 * request schema, `headers` also accepts a (sync or async) factory, and
 * `pathPrefix` is always optional.
 */
export type InjectApiSSEParams<Contract extends ApiContract> = InjectByApiContractParams<Contract>

/** The `responsesByStatusCode` map of a contract. */
type Responses<Contract extends ApiContract> = Contract['responsesByStatusCode']

/** The concrete status codes a contract declares exactly (non-wildcard keys). */
type ExactStatusCodes<Contract extends ApiContract> = keyof Responses<Contract> & HttpStatusCode

/** Status codes covered by any range key (e.g. `'2xx'`, `'4xx'`) the contract declares. */
type RangeStatusCodes<Contract extends ApiContract> = {
  [Key in keyof Responses<Contract> & HttpStatusCodeRange]: ExpandStatusRangeKey<Key>
}[keyof Responses<Contract> & HttpStatusCodeRange]

/**
 * Maps a `responsesByStatusCode` key to the statuses it covers, mirroring the runtime
 * lookup precedence (exact → range → `'default'`): a concrete key stays as-is; a range key
 * expands to its status class minus the exactly-declared codes; `'default'` expands to every
 * status not covered by an exact or range key.
 */
type StatusesForKey<Contract extends ApiContract, Key> = Key extends 'default'
  ? Exclude<HttpStatusCode, ExactStatusCodes<Contract> | RangeStatusCodes<Contract>>
  : Key extends HttpStatusCodeRange
    ? Exclude<ExpandStatusRangeKey<Key>, ExactStatusCodes<Contract>>
    : Key

/** The range key a concrete status code falls into. */
type RangeKeyOf<Status extends HttpStatusCode> = Status extends InformationalHttpStatusCode
  ? '1xx'
  : Status extends SuccessfulHttpStatusCode
    ? '2xx'
    : Status extends RedirectionHttpStatusCode
      ? '3xx'
      : Status extends ClientErrorHttpStatusCode
        ? '4xx'
        : Status extends ServerErrorHttpStatusCode
          ? '5xx'
          : never

/** The media type `injectApiSSE` always asks for — see {@link StreamSchemasOfEntry}. */
type SSEMediaType = 'text/event-stream'

/**
 * The `event name -> schema` map of an SSE body descriptor, or `never` for any other
 * descriptor (a bare Zod schema is JSON, `blobBody()` is opaque bytes).
 */
type SseSchemasOfDescriptor<Descriptor> = Descriptor extends {
  _tag: 'SseBody'
  schemaByEventName: infer Schemas
}
  ? Schemas
  : never

/**
 * Every SSE schema map a response entry declares, across all of its media types — the
 * type-level counterpart of the maps `getSseSchemaByEventName` collects at runtime.
 */
type SseSchemasOfEntry<Entry> = Entry extends { content: infer Content }
  ? SseSchemasOfDescriptor<Content[keyof Content]>
  : never

/**
 * The SSE schema map an entry declares under `text/event-stream` specifically.
 *
 * `injectApiSSE` always sends `accept: text/event-stream`, so this is the descriptor a
 * status resolves to whenever it declares one — even on a dual-mode content map that also
 * carries a JSON schema.
 */
type StreamSchemasOfEntry<Entry> = Entry extends { content: infer Content }
  ? SseSchemasOfDescriptor<Content[SSEMediaType & keyof Content]>
  : never

/**
 * The JSON Zod schema of a single response entry, or `never` when this helper can't reach a
 * JSON body there. A bare schema is JSON; a content-map entry contributes the schemas of its
 * non-blob, non-SSE descriptors.
 *
 * An entry that declares a `text/event-stream` body has no reachable JSON side: the request
 * asks for the stream, so a dual-mode status answers with SSE and `bodyForStatus` would throw.
 * Read those with `events()` instead.
 */
type JsonSchemaOfEntry<Entry> = [StreamSchemasOfEntry<Entry>] extends [never]
  ? Entry extends z.ZodType
    ? Entry
    : Entry extends { content: infer Content }
      ? Extract<Content[keyof Content], z.ZodType>
      : never
  : never

/** Indexes a responses map with a key that may not exist on it (yielding `never` if it doesn't). */
type EntryAt<Contract extends ApiContract, Key> = NonNullable<
  Responses<Contract>[Key & keyof Responses<Contract>]
>

/** The response entry that serves a concrete status, following exact → range → `'default'`. */
type EntryForStatus<Contract extends ApiContract, Status extends HttpStatusCode> = [
  EntryAt<Contract, Status>,
] extends [never]
  ? [EntryAt<Contract, RangeKeyOf<Status>>] extends [never]
    ? EntryAt<Contract, 'default'>
    : EntryAt<Contract, RangeKeyOf<Status>>
  : EntryAt<Contract, Status>

/**
 * Status codes for which the contract declares a JSON response body.
 *
 * Resolves to `never` for contracts that declare none, so `bodyForStatus` is uncallable there.
 * Range and `'default'` keys expand to the concrete statuses they serve, so a contract
 * declaring only `4xx` still allows `bodyForStatus(404)`.
 */
export type ApiDeclaredResponseStatus<Contract extends ApiContract> = {
  [Key in keyof Responses<Contract>]: [JsonSchemaOfEntry<EntryAt<Contract, Key>>] extends [never]
    ? never
    : StatusesForKey<Contract, Key>
}[keyof Responses<Contract>] &
  HttpStatusCode

/** Infers a schema's output type, or `never` when there is no schema. */
type InferJsonBody<Schema> = Schema extends z.ZodType ? z.output<Schema> : never

/** The parsed JSON response body a contract declares for a concrete status. */
export type ApiDeclaredResponseBody<
  Contract extends ApiContract,
  Status extends HttpStatusCode,
> = InferJsonBody<JsonSchemaOfEntry<EntryForStatus<Contract, Status>>>

/**
 * Union of the SSE schema maps a contract declares, over *every* status key.
 *
 * Deliberately not `InferSseSuccessResponses`, which only looks at success / `'2xx'` /
 * `'default'` keys: the runtime `getSseSchemaByEventName` merges the maps of every entry in
 * `responsesByStatusCode`, so a stream declared under e.g. `'4xx'` produces validated events
 * too and has to be visible here.
 */
type ApiSSEEventSchemas<Contract extends ApiContract> = SseSchemasOfEntry<
  NonNullable<Responses<Contract>[keyof Responses<Contract>]>
>

/**
 * The event names of a union of schema maps.
 *
 * `keyof` a union yields only the keys shared by every member, which collapses to `never` as
 * soon as two statuses declare different events — so distribute first and union the keys,
 * mirroring the runtime merge.
 */
type SseEventNamesOf<Schemas> = Schemas extends unknown ? keyof Schemas & string : never

/**
 * The schema(s) a union of maps declares for one event name. Maps that don't declare it drop
 * out; two maps declaring it with different schemas yield a union, since the runtime merge
 * keeps only one of them and the reader can't tell which.
 */
type SseSchemaForEventName<Schemas, Name extends string> =
  Schemas extends Record<Name, infer Schema> ? Schema : never

/** Builds the event union for an already-resolved set of schema maps. */
type ApiSSEEventOf<Schemas> = {
  [Name in SseEventNamesOf<Schemas>]: {
    /** Event ID, when the server sent an `id:` field. */
    id?: string
    /** Event name, as sent in the `event:` field (defaults to `message`). */
    event: Name
    /** Reconnection hint in milliseconds, when the server sent a `retry:` field. */
    retry?: number
    /** `data:` payload, JSON-parsed and validated against the contract's schema. */
    data: InferJsonBody<SseSchemaForEventName<Schemas, Name>>
  }
}[SseEventNamesOf<Schemas>]

/**
 * Discriminated union of the SSE events a contract declares, with `data` parsed and typed
 * per event name. `never` for a contract that declares no SSE response at all.
 */
export type ApiSSEEvent<Contract extends ApiContract> = ApiSSEEventOf<ApiSSEEventSchemas<Contract>>

/** Whether a contract declares an SSE response on any status. */
type HasApiSSEResponse<Contract extends ApiContract> = [ApiSSEEventSchemas<Contract>] extends [
  never,
]
  ? false
  : true

/**
 * The callable form of {@link InjectApiSSEResult.events}.
 *
 * Always a function, so the internal binder has a type to return regardless of what the
 * contract declares; the result type below hides it behind {@link HasApiSSEResponse}.
 */
export type ApiSSEEventReader<Contract extends ApiContract> = () => Promise<ApiSSEEvent<Contract>[]>

/**
 * The callable form of {@link InjectApiSSEResult.stream}.
 *
 * Always a function, for the same reason {@link ApiSSEEventReader} is; the result type below
 * hides it behind {@link HasApiSSEResponse}.
 */
export type ApiSSEStreamReader<Contract extends ApiContract> = (
  signal?: AbortSignal,
) => AsyncGenerator<ApiSSEEvent<Contract>, void, unknown>

/**
 * Result of an {@link injectApiSSE} call.
 *
 * The `defineApiContract` counterpart of `InjectSSEResult`: same `closed` promise and
 * `bodyForStatus` accessor, plus `events()` for reading the stream typed against the
 * contract's `sseResponse` / `sseBody` schemas.
 */
export type InjectApiSSEResult<Contract extends ApiContract> = {
  /**
   * Resolves when the response completes with the full SSE body.
   * Parse the body with `parseSSEEvents()` — or use `events()` for typed events.
   */
  closed: Promise<SSEResponse>

  /**
   * Resolves as soon as the response head is on the wire — for a streaming response, when
   * the handler calls `sse.start()`, long before it finishes.
   *
   * Lets a test assert the status and headers of a stream while the handler is still
   * producing events, which `closed` cannot: it only settles once the stream ends.
   *
   * @example
   * ```typescript
   * const { head, stream } = injectApiSSE(app, contract, { body })
   * expect((await head).statusCode).toBe(200)  // handler is still working
   * ```
   */
  head: Promise<SSEResponseHead>

  /**
   * The sends the route could not make while serving this request — a payload that failed the
   * contract's schema for its event, say — recorded instead of being left in the server log.
   *
   * `events()` and `stream()` already fail on the failures that truncated the response, so
   * this is for the ones they deliberately let pass: a handler that catches its own failed
   * send and streams a fallback produced the response it meant to, and a test asserting on
   * that response should not fail — but may still want to assert the send was attempted, and
   * rejected, exactly once.
   *
   * Only meaningful once the response completed (`await closed`), and only for routes built
   * with this package's `buildApiRoute`; anything else records nothing.
   *
   * @example
   * ```typescript
   * const { closed, events, sendFailures } = injectApiSSE(app, contract, { body })
   * await closed
   * expect(await events()).toHaveLength(2)          // the fallback stream is intact
   * expect(sendFailures()).toMatchObject([{ eventName: 'issue', handled: true }])
   * ```
   */
  sendFailures(): SSESendFailure[]

  /**
   * Awaits the response, asserts the status code matches, parses the body against the
   * contract's JSON schema for that status, and returns the parsed object. Useful for
   * asserting on the documented error responses a handler emits before streaming starts.
   *
   * Throws (with the offending status and a truncated body snippet) if:
   * - the actual status code doesn't match the expected one;
   * - the contract declares no JSON body for that status;
   * - the body isn't valid JSON;
   * - the body doesn't match the declared Zod schema.
   *
   * At the type level, `statusCode` is constrained to the statuses the contract declares a
   * JSON body for. Contracts without any can't call this method (`statusCode: never`).
   *
   * @example
   * ```typescript
   * const { bodyForStatus } = injectApiSSE(app, contract, { body })
   * const error = await bodyForStatus(400)  // typed as z.output<400-schema>
   * expect(error.message).toBe('Bad request')
   * ```
   */
  bodyForStatus<Status extends ApiDeclaredResponseStatus<Contract>>(
    statusCode: Status,
  ): Promise<ApiDeclaredResponseBody<Contract, Status>>

  /**
   * Awaits the response, parses the SSE body, and validates every event against the
   * contract's SSE schemas, returning them as a discriminated union on `event`.
   *
   * Events are typed from the SSE schemas of *every* status the contract declares, merged
   * exactly as the runtime merges them — a contract streaming different events on two
   * statuses yields the union of both.
   *
   * Throws if the response isn't an SSE stream (use `bodyForStatus` for the documented
   * error statuses), if an event name isn't declared by the contract, if an event payload
   * doesn't match its schema, or if a send the route could not make — and did not recover
   * from — ended the stream early (see `sendFailures()`).
   *
   * A contract that declares no SSE response at all types this as `never`, so calling it is
   * a compile error rather than a guaranteed throw — reach for `injectByApiContract` there.
   *
   * @example
   * ```typescript
   * const events = await injectApiSSE(app, contract, { body }).events()
   * const review = events.find((event) => event.event === 'review')
   * expect(review?.data.score).toBe(42)  // `data` typed by the `review` schema
   * ```
   */
  events: HasApiSSEResponse<Contract> extends true ? ApiSSEEventReader<Contract> : never

  /**
   * Yields the contract's events as the handler writes them, rather than after the response
   * completes — the same discriminated union and the same validation `events()` provides.
   *
   * This is what `events()` cannot show: that event N reached the client while the handler
   * was still working. The request is injected with Fastify's `payloadAsStream`, so no
   * `app.listen()`, base URL or manual connection cleanup is involved.
   *
   * Events are buffered from the moment the request is injected, so a generator started
   * late still yields the stream from its first event, and the handler is never blocked by
   * a slow (or absent) consumer. Breaking out of the loop leaves the rest of the stream
   * readable through `closed` / `events()`; calling `stream()` again replays it from the
   * start.
   *
   * Throws — before yielding anything — if the response isn't an SSE stream, and rethrows
   * the same event-level validation errors `events()` does. If the stream was cut short by a
   * send the route could not make (a payload that didn't match the contract's schema for its
   * event, and that nothing caught), the generator ends by throwing an error naming that
   * event and its Zod issues, instead of leaving the test to explain a missing event on its
   * own. A failure the route did catch and recovered from is left to `sendFailures()`.
   *
   * A contract that declares no SSE response types this as `never`, exactly as `events()`.
   *
   * @param signal - Optional `AbortSignal` to stop the generator early
   *
   * @example
   * ```typescript
   * const { stream } = injectApiSSE(app, lqaSegmentContract, { body: { segment } })
   *
   * for await (const event of stream()) {
   *   if (event.event === 'issue') expect(handlerFinished).toBe(false)  // progressive delivery
   * }
   * ```
   */
  stream: HasApiSSEResponse<Contract> extends true ? ApiSSEStreamReader<Contract> : never
}
