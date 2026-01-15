import type { FastifyInstance } from 'fastify'
import { type ParsedSSEEvent, parseSSEEvents } from '../sse/sseParser.ts'
import type { SSEConnectOptions, SSETestConnection } from './sseTestTypes.ts'

/**
 * Response from a Fastify inject() call for SSE.
 */
export type SSEInjectResponse = {
  statusCode: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

/**
 * SSE connection object returned by SSEInjectClient.
 *
 * Represents a completed SSE response from Fastify's inject().
 * Since inject() waits for the complete response, all events
 * are available immediately after construction.
 */
export class SSEInjectConnection implements SSETestConnection {
  private readonly receivedEvents: ParsedSSEEvent[] = []
  private readonly response: SSEInjectResponse

  constructor(response: SSEInjectResponse) {
    this.response = response

    // Parse all events from response body (inject waits for complete response)
    if (response.body) {
      const events = parseSSEEvents(response.body)
      this.receivedEvents.push(...events)
    }
  }

  /**
   * Wait for a specific event by name.
   * Since inject() returns the complete response, this searches
   * the already-received events.
   */
  async waitForEvent(eventName: string, timeout = 5000): Promise<ParsedSSEEvent> {
    const startTime = Date.now()

    while (Date.now() - startTime < timeout) {
      const event = this.receivedEvents.find((e) => e.event === eventName)
      if (event) {
        return event
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    throw new Error(`Timeout waiting for event: ${eventName}`)
  }

  /**
   * Wait for a specific number of events.
   * Since inject() returns the complete response, this checks
   * the already-received events.
   */
  async waitForEvents(count: number, timeout = 5000): Promise<ParsedSSEEvent[]> {
    const startTime = Date.now()

    while (Date.now() - startTime < timeout) {
      if (this.receivedEvents.length >= count) {
        return this.receivedEvents.slice(0, count)
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    throw new Error(`Timeout waiting for ${count} events, received ${this.receivedEvents.length}`)
  }

  /**
   * Get all events received in the response.
   */
  getReceivedEvents(): ParsedSSEEvent[] {
    return [...this.receivedEvents]
  }

  /**
   * Close the connection. No-op for inject connections since
   * the response is already complete.
   */
  close(): void {
    // No-op - inject() responses are already complete
  }

  /**
   * Check if the connection has been closed.
   * Always returns true for inject connections since response is complete.
   */
  isClosed(): boolean {
    return true
  }

  /**
   * Get the HTTP status code from the response.
   */
  getStatusCode(): number {
    return this.response.statusCode
  }

  /**
   * Get the response headers.
   */
  getHeaders(): Record<string, string | string[] | undefined> {
    return this.response.headers
  }
}

/**
 * SSE client using Fastify's inject() for testing SSE endpoints.
 *
 * This client uses Fastify's `inject()` method which simulates HTTP requests
 * without network overhead. The key characteristic is that `inject()` waits
 * for the **complete response** before returning, meaning:
 *
 * - All events are available immediately after connect() returns
 * - The SSE handler must close the connection for connect() to complete
 * - Best suited for SSE streams that have a defined end
 *
 * **Ideal for testing:**
 * - OpenAI-style streaming (POST with body, streams tokens, then closes)
 * - Short-lived streams that complete after sending all events
 * - Endpoints where you want to test the full response at once
 *
 * **When to use SSEInjectClient vs SSEHttpClient:**
 *
 * | SSEInjectClient (this class)        | SSEHttpClient                        |
 * |-------------------------------------|--------------------------------------|
 * | Fastify's inject() (no network)     | Real HTTP connection via fetch()    |
 * | All events returned at once         | Events arrive incrementally         |
 * | Handler must close the connection   | Connection can stay open            |
 * | Works without starting server       | Requires running server (listen())  |
 * | Use for: OpenAI-style, completions  | Use for: notifications, chat, feeds |
 *
 * @example
 * ```typescript
 * // Testing OpenAI-style chat completion streaming
 * const client = new SSEInjectClient(app)
 *
 * // POST request that streams response and closes
 * const conn = await client.connectWithBody(
 *   '/api/chat/completions',
 *   { model: 'gpt-4', messages: [{ role: 'user', content: 'Hello' }], stream: true }
 * )
 *
 * // connect() returns after handler closes - all events are available
 * expect(conn.getStatusCode()).toBe(200)
 *
 * // Get all events that were streamed
 * const events = conn.getReceivedEvents()
 * expect(events[events.length - 1].event).toBe('done')
 *
 * // Parse the streamed content
 * const chunks = events
 *   .filter(e => e.event === 'chunk')
 *   .map(e => JSON.parse(e.data).content)
 * const fullResponse = chunks.join('')
 * ```
 *
 * @example
 * ```typescript
 * // Testing GET SSE endpoint
 * const client = new SSEInjectClient(app)
 * const conn = await client.connect('/api/export/progress', {
 *   headers: { authorization: 'Bearer token' }
 * })
 *
 * // Wait for specific event type
 * const completeEvent = await conn.waitForEvent('complete')
 * expect(JSON.parse(completeEvent.data)).toMatchObject({ status: 'success' })
 * ```
 */
export class SSEInjectClient {
  // biome-ignore lint/suspicious/noExplicitAny: Fastify instance types are complex
  private readonly app: FastifyInstance<any, any, any, any>

  /**
   * Create a new SSE inject client.
   * @param app - Fastify instance (does not need to be listening)
   */
  // biome-ignore lint/suspicious/noExplicitAny: Fastify instance types are complex
  constructor(app: FastifyInstance<any, any, any, any>) {
    this.app = app
  }

  /**
   * Send a GET request to an SSE endpoint.
   *
   * Returns when the SSE handler closes the connection.
   * All events are then available via getReceivedEvents().
   *
   * @param url - The endpoint URL (e.g., '/api/stream')
   * @param options - Optional headers
   * @returns Connection object with all received events
   *
   * @example
   * ```typescript
   * const conn = await client.connect('/api/notifications/stream', {
   *   headers: { authorization: 'Bearer token' }
   * })
   * const events = conn.getReceivedEvents()
   * ```
   */
  async connect(
    url: string,
    options?: Omit<SSEConnectOptions, 'method' | 'body'>,
  ): Promise<SSEInjectConnection> {
    const response = await this.app.inject({
      method: 'GET',
      url,
      headers: {
        accept: 'text/event-stream',
        ...options?.headers,
      },
    })

    return new SSEInjectConnection({
      statusCode: response.statusCode,
      headers: response.headers as Record<string, string | string[] | undefined>,
      body: response.body,
    })
  }

  /**
   * Send a POST/PUT/PATCH request to an SSE endpoint with a body.
   *
   * This is the typical pattern for OpenAI-style streaming APIs where
   * you send a request body and receive a streamed response.
   *
   * Returns when the SSE handler closes the connection.
   * All events are then available via getReceivedEvents().
   *
   * @param url - The endpoint URL (e.g., '/api/chat/completions')
   * @param body - Request body (will be JSON stringified)
   * @param options - Optional method (defaults to POST) and headers
   * @returns Connection object with all received events
   *
   * @example
   * ```typescript
   * const conn = await client.connectWithBody(
   *   '/api/chat/completions',
   *   { model: 'gpt-4', messages: [...], stream: true },
   *   { headers: { authorization: 'Bearer sk-...' } }
   * )
   * const chunks = conn.getReceivedEvents().filter(e => e.event === 'chunk')
   * ```
   */
  async connectWithBody(
    url: string,
    body: unknown,
    options?: Omit<SSEConnectOptions, 'body'>,
  ): Promise<SSEInjectConnection> {
    const response = await this.app.inject({
      method: options?.method ?? 'POST',
      url,
      headers: {
        accept: 'text/event-stream',
        'content-type': 'application/json',
        ...options?.headers,
      },
      payload: JSON.stringify(body),
    })

    return new SSEInjectConnection({
      statusCode: response.statusCode,
      headers: response.headers as Record<string, string | string[] | undefined>,
      body: response.body,
    })
  }
}
