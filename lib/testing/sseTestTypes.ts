import type { AnySSEContractDefinition, HttpStatusCode } from '@lokalise/api-contracts'
import type { ParsedSSEEvent } from '@opinionated-machine/sse-parser'
import type { InjectOptions } from 'fastify'
import type { z } from 'zod'

/**
 * HTTP methods Fastify's `inject()` accepts, in either case.
 *
 * Derived from Fastify's own inject options instead of being hand-listed, so it
 * tracks whatever the installed Fastify supports and never needs to be redefined
 * downstream. Note that Fastify's `HTTPMethods` is wider than this - it also
 * covers `SEARCH`, `QUERY` and the WebDAV verbs, which `inject()` does not take.
 */
export type SSEInjectMethod = NonNullable<InjectOptions['method']>

/** Safely infer the output type of an optional Zod schema property. */
type InferOptionalSchema<T, Fallback = unknown> =
  NonNullable<T> extends z.ZodTypeAny ? z.infer<NonNullable<T>> : Fallback

/**
 * Status codes that the given schemas-map declares.
 * Resolves to `never` when the map is `undefined`, so `bodyForStatus` is
 * uncallable for contracts that declare no response body schemas at all.
 */
export type DeclaredResponseStatus<
  Schemas extends Partial<Record<HttpStatusCode, z.ZodTypeAny>> | undefined,
> =
  Schemas extends Partial<Record<HttpStatusCode, z.ZodTypeAny>>
    ? keyof Schemas & HttpStatusCode
    : never

/** Type of the parsed response body for a declared status. */
export type DeclaredResponseBody<
  Schemas extends Partial<Record<HttpStatusCode, z.ZodTypeAny>> | undefined,
  Status extends DeclaredResponseStatus<Schemas>,
> =
  Schemas extends Partial<Record<HttpStatusCode, z.ZodTypeAny>>
    ? Status extends keyof Schemas
      ? Schemas[Status] extends z.ZodTypeAny
        ? z.infer<Schemas[Status]>
        : never
      : never
    : never

/**
 * Represents an active SSE test connection (inject-based).
 *
 * This interface is used with Fastify's inject() for testing SSE endpoints
 * synchronously. For long-lived connections, use SSEHttpClient instead.
 */
export interface SSETestConnection {
  /**
   * Wait for a specific event by name.
   * @param eventName - The event name to wait for
   * @param timeout - Timeout in milliseconds (default: 5000)
   */
  waitForEvent(eventName: string, timeout?: number): Promise<ParsedSSEEvent>

  /**
   * Wait for a specific number of events.
   * @param count - Number of events to wait for
   * @param timeout - Timeout in milliseconds (default: 5000)
   */
  waitForEvents(count: number, timeout?: number): Promise<ParsedSSEEvent[]>

  /**
   * Get all events received so far.
   */
  getReceivedEvents(): ParsedSSEEvent[]

  /**
   * Close the connection.
   */
  close(): void

  /**
   * Check if connection is closed.
   */
  isClosed(): boolean

  /**
   * Get the HTTP response status code.
   */
  getStatusCode(): number

  /**
   * Get response headers.
   */
  getHeaders(): Record<string, string | string[] | undefined>

  /**
   * Get the raw response body as a string.
   *
   * For a successful SSE response this is the raw `text/event-stream` payload
   * (already parsed into events, available via `getReceivedEvents()`). It is
   * most useful when the route answered with a status code before streaming
   * started - an auth failure, a validation error, an unavailable integration -
   * and responded with a JSON body instead of events.
   */
  getBody(): string

  /**
   * Parse the raw response body as JSON.
   *
   * Mirrors Fastify's own inject response `json()`. Intended for non-streaming
   * responses emitted before streaming starts; calling it on an actual SSE
   * stream body throws, since `text/event-stream` is not JSON.
   *
   * @throws if the body is empty or not valid JSON (the message includes a
   * truncated body snippet).
   *
   * @example
   * ```typescript
   * const conn = await client.connect('/api/stream')
   * expect(conn.getStatusCode()).toBe(503)
   * expect(conn.json()).toMatchObject({ errorCode: 'INTEGRATION_NOT_AVAILABLE' })
   * ```
   */
  json<T = unknown>(): T
}

/**
 * Options for establishing an SSE connection.
 */
export type SSEConnectOptions = {
  headers?: Record<string, string>
  /** Any method `inject()` accepts (default: `'POST'` for `connectWithBody`) */
  method?: SSEInjectMethod
  body?: unknown
}

/**
 * Options for injectSSE (GET SSE routes).
 */
export type InjectSSEOptions<Contract extends AnySSEContractDefinition> = {
  params?: InferOptionalSchema<Contract['requestPathParamsSchema']>
  query?: InferOptionalSchema<Contract['requestQuerySchema']>
  headers?: InferOptionalSchema<Contract['requestHeaderSchema']>
}

/**
 * Options for injectPayloadSSE (POST/PUT/PATCH SSE routes).
 */
export type InjectPayloadSSEOptions<Contract extends AnySSEContractDefinition> = {
  params?: InferOptionalSchema<Contract['requestPathParamsSchema']>
  query?: InferOptionalSchema<Contract['requestQuerySchema']>
  headers?: InferOptionalSchema<Contract['requestHeaderSchema']>
  body: InferOptionalSchema<Contract['requestBodySchema'], never>
}

/**
 * Status code and headers of an SSE response, available as soon as they are on the wire —
 * before the handler has finished streaming.
 */
export type SSEResponseHead = {
  statusCode: number
  headers: Record<string, string | string[] | undefined>
}

/**
 * SSE response data.
 */
export type SSEResponse = SSEResponseHead & {
  body: string
}

/**
 * Result of an SSE inject call.
 *
 * Note: Fastify's inject() waits for the full response, so these helpers
 * work best for streaming that completes (OpenAI-style). For long-lived
 * SSE connections, use `SSEHttpClient` with a real HTTP server instead.
 *
 * When the contract declares `responseBodySchemasByStatusCode`, the result
 * exposes `bodyForStatus(status)` — a typed accessor that parses the response
 * body against the contract's schema for that status. TS rejects status codes
 * the contract doesn't declare.
 */
export type InjectSSEResult<
  Schemas extends Partial<Record<HttpStatusCode, z.ZodTypeAny>> | undefined = undefined,
> = {
  /**
   * Resolves when the response completes with the full SSE body.
   * Parse the body with `parseSSEEvents()` to get individual events.
   */
  closed: Promise<SSEResponse>

  /**
   * Awaits the response, asserts the status code matches, parses the body
   * against the contract's schema for that status, and returns the parsed
   * object. Useful for asserting on documented error response shapes.
   *
   * Intended for non-streaming responses emitted via `sse.respond(status, body)`
   * before streaming starts (auth failures, validation errors, not-found).
   * Calling it for a status served by an actual SSE stream fails at the
   * JSON-parse step, since a stream body is `text/event-stream`, not JSON.
   *
   * Throws (with the offending status and a truncated body snippet) if:
   * - the actual status code doesn't match the expected one;
   * - the contract declares no schema for that status;
   * - the body isn't valid JSON;
   * - the body doesn't match the declared Zod schema.
   *
   * At the type level, `statusCode` is constrained to the keys of the
   * contract's `responseBodySchemasByStatusCode`. Contracts without any
   * declared schemas can't call this method (`statusCode: never`).
   *
   * @example
   * ```typescript
   * const { bodyForStatus } = injectSSE(app, contract, { headers })
   * const error = await bodyForStatus(401)  // typed as z.infer<401-schema>
   * expect(error.message).toBe('Unauthorized')
   * ```
   */
  bodyForStatus<Status extends DeclaredResponseStatus<Schemas>>(
    statusCode: Status,
  ): Promise<DeclaredResponseBody<Schemas, Status>>
}
