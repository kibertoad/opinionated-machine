import type {
  ApiContract,
  ClientErrorHttpStatusCode,
  ExpandStatusRangeKey,
  HttpStatusCode,
  HttpStatusCodeRange,
  InferSseSuccessResponses,
  InformationalHttpStatusCode,
  RedirectionHttpStatusCode,
  ServerErrorHttpStatusCode,
  SuccessfulHttpStatusCode,
} from '@lokalise/api-contracts'
import type { InjectByApiContractParams } from '@lokalise/fastify-api-contracts'
import type { z } from 'zod'
import type { SSEResponse } from './sseTestTypes.ts'

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

/**
 * The JSON Zod schema of a single response entry, or `never` when it carries no JSON body.
 * A bare schema is JSON; a content-map entry contributes the schemas of its non-blob,
 * non-SSE descriptors.
 */
type JsonSchemaOfEntry<Entry> = Entry extends z.ZodType
  ? Entry
  : Entry extends { content: infer Content }
    ? Extract<Content[keyof Content], z.ZodType>
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

/** The merged `event name -> schema` map of every SSE response a contract declares. */
type ApiSSEEventSchemas<Contract extends ApiContract> = InferSseSuccessResponses<
  Responses<Contract>
>

/**
 * Discriminated union of the SSE events a contract declares, with `data` parsed and typed
 * per event name.
 */
export type ApiSSEEvent<Contract extends ApiContract> = {
  [Name in keyof ApiSSEEventSchemas<Contract> & string]: {
    /** Event ID, when the server sent an `id:` field. */
    id?: string
    /** Event name, as sent in the `event:` field (defaults to `message`). */
    event: Name
    /** Reconnection hint in milliseconds, when the server sent a `retry:` field. */
    retry?: number
    /** `data:` payload, JSON-parsed and validated against the contract's schema. */
    data: InferJsonBody<ApiSSEEventSchemas<Contract>[Name]>
  }
}[keyof ApiSSEEventSchemas<Contract> & string]

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
   * Throws if the response isn't an SSE stream (use `bodyForStatus` for the documented
   * error statuses), if the contract declares no SSE response, if an event name isn't
   * declared by the contract, or if an event payload doesn't match its schema.
   *
   * @example
   * ```typescript
   * const events = await injectApiSSE(app, contract, { body }).events()
   * const review = events.find((event) => event.event === 'review')
   * expect(review?.data.score).toBe(42)  // `data` typed by the `review` schema
   * ```
   */
  events(): Promise<ApiSSEEvent<Contract>[]>
}
