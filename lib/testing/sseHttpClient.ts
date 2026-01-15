import { stringify } from 'fast-querystring'
import type { SSEConnectionSpy } from '../sse/SSEConnectionSpy.ts'
import { type ParsedSSEEvent, parseSSEBuffer } from '../sse/sseParser.ts'
import type { SSEConnection } from '../sse/sseTypes.ts'

/**
 * Interface for objects that have a connectionSpy (e.g., SSE controllers in test mode).
 */
export type HasConnectionSpy = { connectionSpy: SSEConnectionSpy }

/**
 * Options for connecting to an SSE endpoint via HTTP.
 */
export type SSEHttpConnectOptions = {
  /** Query parameters to add to the URL */
  query?: Record<string, string | undefined>
  /** Additional headers to send with the request */
  headers?: Record<string, string>
}

/**
 * Options for connecting with automatic server-side connection waiting.
 */
export type SSEHttpConnectWithSpyOptions = SSEHttpConnectOptions & {
  /**
   * Wait for server-side connection registration after HTTP headers are received.
   * This eliminates the race condition between `connect()` returning and the
   * server-side handler completing connection registration.
   */
  awaitServerConnection: {
    /** The SSE controller (must have connectionSpy enabled via isTestMode) */
    controller: HasConnectionSpy
    /** Timeout in milliseconds (default: 5000) */
    timeout?: number
  }
}

/**
 * Result when connecting with awaitServerConnection option.
 */
export type SSEHttpConnectResult = {
  client: SSEHttpClient
  serverConnection: SSEConnection
}

/**
 * SSE client for testing long-lived connections using real HTTP.
 *
 * This client uses the native `fetch()` API to establish a real HTTP connection
 * to an SSE endpoint. Events are streamed incrementally as the server sends them,
 * making it suitable for testing:
 *
 * - **Long-lived connections** that stay open indefinitely
 * - **Real-time notifications** where events arrive over time
 * - **Push-based streaming** where the client waits for server-initiated events
 *
 * **When to use SSEHttpClient vs SSEInjectClient:**
 *
 * | SSEHttpClient (this class)          | SSEInjectClient                      |
 * |-------------------------------------|--------------------------------------|
 * | Real HTTP connection via fetch()    | Fastify's inject() (no network)     |
 * | Events arrive incrementally         | All events returned at once         |
 * | Connection can stay open            | Response must complete              |
 * | Requires running server (listen())  | Works without starting server       |
 * | Use for: notifications, chat, feeds | Use for: OpenAI-style streaming     |
 *
 * @example
 * ```typescript
 * // 1. Start a real HTTP server
 * await app.listen({ port: 0 })
 * const address = app.server.address() as { port: number }
 * const baseUrl = `http://localhost:${address.port}`
 *
 * // 2. Connect to SSE endpoint (returns when headers are received)
 * const client = await SSEHttpClient.connect(baseUrl, '/api/notifications', {
 *   headers: { authorization: 'Bearer token' },
 * })
 *
 * // 3. Server can now send events at any time
 * controller.sendEvent(connectionId, { event: 'notification', data: { msg: 'Hello' } })
 *
 * // 4. Collect events as they arrive
 * const events = await client.collectEvents(3) // wait for 3 events
 * // or: collect until a specific event
 * const events = await client.collectEvents(e => e.event === 'done')
 *
 * // 5. Alternative: use async iterator for manual control
 * for await (const event of client.events()) {
 *   console.log('Received:', event.event, event.data)
 *   if (event.event === 'done') break
 * }
 *
 * // 6. Cleanup
 * client.close()
 * await app.close()
 * ```
 */
export class SSEHttpClient {
  /** The fetch Response object. Available immediately after connect() returns. */
  readonly response: Response
  private readonly abortController: AbortController
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  private readonly decoder = new TextDecoder()
  private buffer = ''
  private closed = false

  private constructor(response: Response, abortController: AbortController) {
    this.response = response
    this.abortController = abortController
    if (!response.body) {
      throw new Error('SSE response has no body')
    }
    this.reader = response.body.getReader()
  }

  /**
   * Connect to an SSE endpoint.
   *
   * The returned promise resolves as soon as HTTP headers are received,
   * indicating the connection is established. Events can then be consumed
   * via `events()` or `collectEvents()`.
   *
   * @param baseUrl - Base URL of the server (e.g., 'http://localhost:3000')
   * @param path - SSE endpoint path (e.g., '/api/notifications')
   * @param options - Connection options (query params, headers)
   * @returns Connected SSE client ready to receive events
   *
   * @example
   * ```typescript
   * // Basic connection (returns when HTTP headers received)
   * const client = await SSEHttpClient.connect(
   *   'http://localhost:3000',
   *   '/api/stream',
   *   { query: { userId: '123' }, headers: { authorization: 'Bearer token' } }
   * )
   *
   * // With awaitServerConnection (waits for server-side registration)
   * const { client, serverConnection } = await SSEHttpClient.connect(
   *   'http://localhost:3000',
   *   '/api/stream',
   *   { awaitServerConnection: { controller } }
   * )
   * // serverConnection is ready to use immediately
   * await controller.sendEvent(serverConnection.id, { event: 'test', data: {} })
   * ```
   */
  static async connect(
    baseUrl: string,
    path: string,
    options: SSEHttpConnectWithSpyOptions,
  ): Promise<SSEHttpConnectResult>
  static async connect(
    baseUrl: string,
    path: string,
    options?: SSEHttpConnectOptions,
  ): Promise<SSEHttpClient>
  static async connect(
    baseUrl: string,
    path: string,
    options?: SSEHttpConnectOptions | SSEHttpConnectWithSpyOptions,
  ): Promise<SSEHttpClient | SSEHttpConnectResult> {
    // Build path with query string
    let pathWithQuery = path
    if (options?.query) {
      const queryString = stringify(options.query)
      if (queryString) {
        pathWithQuery = `${path}?${queryString}`
      }
    }

    // Connect - fetch() returns when headers are received
    const abortController = new AbortController()
    const response = await fetch(`${baseUrl}${pathWithQuery}`, {
      headers: {
        Accept: 'text/event-stream',
        ...options?.headers,
      },
      signal: abortController.signal,
    })

    const client = new SSEHttpClient(response, abortController)

    // If awaitServerConnection is specified, wait for server-side registration
    if (options && 'awaitServerConnection' in options && options.awaitServerConnection) {
      const { controller, timeout } = options.awaitServerConnection
      const serverConnection = await controller.connectionSpy.waitForConnection({
        timeout: timeout ?? 5000,
        predicate: (conn) => conn.request.url === pathWithQuery,
      })
      return { client, serverConnection }
    }

    return client
  }

  /**
   * Async generator that yields parsed SSE events as they arrive.
   *
   * Use this for full control over event processing. The generator
   * completes when the server closes the connection.
   *
   * @example
   * ```typescript
   * for await (const event of client.events()) {
   *   const data = JSON.parse(event.data)
   *   console.log(`[${event.event}]`, data)
   *
   *   if (event.event === 'done') {
   *     break // Stop consuming, connection stays open until close()
   *   }
   * }
   * ```
   */
  async *events(): AsyncGenerator<ParsedSSEEvent, void, unknown> {
    while (!this.closed) {
      const { done, value } = await this.reader.read()
      if (done) {
        this.closed = true
        break
      }

      this.buffer += this.decoder.decode(value, { stream: true })

      // Parse complete events from buffer and get remaining buffer
      const parseResult = parseSSEBuffer(this.buffer)
      this.buffer = parseResult.remaining

      // Yield each parsed event
      for (const event of parseResult.events) {
        yield event
      }
    }
  }

  /**
   * Collect events until a count is reached or predicate returns true.
   *
   * @param countOrPredicate - Either a number of events to collect,
   *   or a predicate function that returns true when collection should stop.
   *   The event that matches the predicate IS included in the result.
   * @param timeout - Maximum time to wait in milliseconds (default: 5000)
   * @returns Array of collected events
   * @throws Error if timeout is reached before condition is met
   *
   * @example
   * ```typescript
   * // Collect exactly 5 events
   * const events = await client.collectEvents(5)
   *
   * // Collect until 'done' event is received
   * const events = await client.collectEvents(e => e.event === 'done')
   *
   * // Collect with custom timeout
   * const events = await client.collectEvents(10, 30000) // 30s timeout
   * ```
   */
  async collectEvents(
    countOrPredicate: number | ((event: ParsedSSEEvent) => boolean),
    timeout = 5000,
  ): Promise<ParsedSSEEvent[]> {
    const collected: ParsedSSEEvent[] = []
    const startTime = Date.now()
    const isCount = typeof countOrPredicate === 'number'
    const iterator = this.events()

    while (true) {
      const remainingTime = timeout - (Date.now() - startTime)
      if (remainingTime <= 0) {
        throw new Error(`Timeout collecting events (got ${collected.length})`)
      }

      // Race between the next event and timeout
      const timeoutPromise = new Promise<{ timeout: true }>((resolve) =>
        setTimeout(() => resolve({ timeout: true }), remainingTime),
      )
      const nextPromise = iterator.next().then((result) => ({ ...result, timeout: false as const }))

      const result = await Promise.race([nextPromise, timeoutPromise])

      if (result.timeout) {
        throw new Error(`Timeout collecting events (got ${collected.length})`)
      }

      if (result.done) {
        break
      }

      collected.push(result.value)

      if (isCount && collected.length >= countOrPredicate) {
        break
      }
      if (!isCount && countOrPredicate(result.value)) {
        break
      }
    }

    return collected
  }

  /**
   * Close the connection from the client side.
   *
   * This aborts the underlying fetch request. Call this when done
   * consuming events to clean up resources.
   */
  close(): void {
    this.closed = true
    this.abortController.abort()
  }
}
