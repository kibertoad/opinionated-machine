import type { ParsedSSEEvent } from '@opinionated-machine/sse-parser'
import type { InjectOptions } from 'fastify'

/**
 * HTTP methods Fastify's `inject()` accepts, in either case.
 *
 * Derived from Fastify's own inject options instead of being hand-listed, so it
 * tracks whatever the installed Fastify supports and never needs to be redefined
 * downstream. Note that Fastify's `HTTPMethods` is wider than this - it also
 * covers `SEARCH`, `QUERY` and the WebDAV verbs, which `inject()` does not take.
 */
export type SSEInjectMethod = NonNullable<InjectOptions['method']>

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
