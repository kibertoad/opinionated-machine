import { stringify } from 'fast-querystring'
import type { SSESession } from '../routes/fastifyRouteTypes.ts'
import type { SpiedSSESession, SSESessionSpy } from '../sse/SSESessionSpy.ts'
import { type ParsedSSEEvent, parseSSEBuffer } from '../sse/sseParser.ts'

/**
 * Interface for objects that have a sessionSpy (e.g., SSE controllers in test mode).
 */
export type HasSessionSpy = { connectionSpy: SSESessionSpy }

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
 * Options for connecting with automatic server-side connection waiting,
 * driven by a controller's built-in `connectionSpy`.
 */
export type SSEHttpConnectWithSpyOptions = SSEHttpConnectOptions & {
  /**
   * Wait for server-side connection registration after HTTP headers are received.
   * This eliminates the race condition between `connect()` returning and the
   * server-side handler completing connection registration.
   */
  awaitServerConnection: {
    /** The SSE controller (must have connectionSpy enabled via isTestMode) */
    controller: HasSessionSpy
    /** Timeout in milliseconds (default: 5000) */
    timeout?: number
  }
}

/**
 * Options for connecting with automatic server-side connection waiting,
 * driven by a standalone spy from `createSSESessionSpy()`.
 *
 * Use this for routes built with `buildApiRoute`, which have no controller to
 * read a `connectionSpy` off of.
 */
export type SSEHttpConnectWithSessionSpyOptions<TSession extends SpiedSSESession> =
  SSEHttpConnectOptions & {
    /**
     * Wait for server-side connection registration after HTTP headers are received.
     * This eliminates the race condition between `connect()` returning and the
     * server-side handler completing connection registration.
     */
    awaitServerConnection: {
      /** A standalone spy, wired to the route via `createSSESessionSpy()`'s `routeOptions` */
      spy: SSESessionSpy<TSession>
      /** Timeout in milliseconds (default: 5000) */
      timeout?: number
    }
  }

/**
 * Result when connecting with awaitServerConnection option.
 */
export type SSEHttpConnectResult<TSession extends SpiedSSESession = SSESession> = {
  client: SSEHttpClient
  serverConnection: TSession
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
   *
   * // Same, for a `buildApiRoute` route with no controller: wire a standalone
   * // spy into the route's hooks with createSSESessionSpy()
   * const { spy, routeOptions } = createSSESessionSpy()
   * const { client, serverConnection } = await SSEHttpClient.connect(
   *   'http://localhost:3000',
   *   '/api/stream',
   *   { awaitServerConnection: { spy } }
   * )
   * await serverConnection.send('test', {})
   * ```
   */
  static async connect(
    baseUrl: string,
    path: string,
    options: SSEHttpConnectWithSpyOptions,
  ): Promise<SSEHttpConnectResult>
  static async connect<TSession extends SpiedSSESession>(
    baseUrl: string,
    path: string,
    options: SSEHttpConnectWithSessionSpyOptions<TSession>,
  ): Promise<SSEHttpConnectResult<TSession>>
  static async connect(
    baseUrl: string,
    path: string,
    options?: SSEHttpConnectOptions,
  ): Promise<SSEHttpClient>
  static async connect(
    baseUrl: string,
    path: string,
    options?:
      | SSEHttpConnectOptions
      | SSEHttpConnectWithSpyOptions
      | SSEHttpConnectWithSessionSpyOptions<SpiedSSESession>,
  ): Promise<SSEHttpClient | SSEHttpConnectResult<SpiedSSESession>> {
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

    let client: SSEHttpClient
    try {
      client = new SSEHttpClient(response, abortController)
    } catch (error) {
      // Nothing owns the response yet, so abort it here rather than leaking it.
      abortController.abort()
      throw error
    }

    // If awaitServerConnection is specified, wait for server-side registration
    if (options && 'awaitServerConnection' in options && options.awaitServerConnection) {
      const awaitOptions = options.awaitServerConnection
      const waitOptions = {
        timeout: awaitOptions.timeout ?? 5000,
        predicate: (conn: SpiedSSESession) => conn.request.url === pathWithQuery,
      }
      try {
        // Both branches call the same method; the spy is invariant in its session
        // type, so they cannot be collapsed into one reference.
        const serverConnection =
          'spy' in awaitOptions
            ? await awaitOptions.spy.waitForConnection(waitOptions)
            : await awaitOptions.controller.connectionSpy.waitForConnection(waitOptions)
        return { client, serverConnection }
      } catch (error) {
        // The HTTP connection is already established and the caller never gets a
        // handle to it, so close it here. Left open, a keep-alive route keeps the
        // socket streaming and the test's `app.close()` hangs, hiding this error
        // behind a suite-level timeout.
        client.close()
        throw error
      }
    }

    return client
  }

  /**
   * Async generator that yields parsed SSE events as they arrive.
   *
   * Use this for full control over event processing. The generator
   * completes when the server closes the connection or the abort signal fires.
   *
   * @param signal - Optional AbortSignal to stop the generator early
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
   *
   * @example
   * ```typescript
   * // With abort signal for timeout control
   * const controller = new AbortController()
   * setTimeout(() => controller.abort(), 5000)
   *
   * for await (const event of client.events(controller.signal)) {
   *   console.log(event)
   * }
   * ```
   */
  async *events(signal?: AbortSignal): AsyncGenerator<ParsedSSEEvent, void, unknown> {
    while (!this.closed) {
      if (signal?.aborted) {
        return
      }

      const readResult = await this.readWithAbort(signal)
      if (readResult === 'aborted') {
        return
      }

      if (readResult.done) {
        this.closed = true
        break
      }

      this.buffer += this.decoder.decode(readResult.value, { stream: true })
      const parseResult = parseSSEBuffer(this.buffer)
      this.buffer = parseResult.remaining

      for (const event of parseResult.events) {
        if (signal?.aborted) {
          return
        }
        yield event
      }
    }
  }

  /**
   * Read from the stream with abort signal support.
   * Returns 'aborted' if the signal fires before read completes.
   */
  private async readWithAbort(signal?: AbortSignal) {
    const readPromise = this.reader.read()

    if (!signal) {
      return readPromise
    }

    let raceSettled = false

    const abortPromise = new Promise<'aborted'>((resolve) => {
      const onAbort = () => {
        if (!raceSettled) {
          resolve('aborted')
        }
      }
      if (signal.aborted) {
        onAbort()
      } else {
        signal.addEventListener('abort', onAbort, { once: true })
      }
    })

    const result = await Promise.race([readPromise, abortPromise])
    raceSettled = true

    if (result === 'aborted') {
      // Prevent unhandled rejection when connection closes
      readPromise.catch(() => {})
    }

    return result
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
    const isCount = typeof countOrPredicate === 'number'
    const abortController = new AbortController()
    const iterator = this.events(abortController.signal)
    let timedOut = false

    const timeoutId = setTimeout(() => {
      timedOut = true
      abortController.abort(new Error(`Timeout collecting events (got ${collected.length})`))
    }, timeout)

    try {
      for await (const event of iterator) {
        collected.push(event)

        if (isCount && collected.length >= countOrPredicate) {
          break
        }
        if (!isCount && countOrPredicate(event)) {
          break
        }
      }

      // Check if loop exited due to timeout (generator returns cleanly on abort)
      if (timedOut) {
        throw abortController.signal.reason
      }
    } catch (err) {
      // Re-throw abort errors with our timeout message
      if (timedOut && abortController.signal.aborted) {
        throw abortController.signal.reason
      }
      throw err
    } finally {
      clearTimeout(timeoutId)
      abortController.abort() // Signal generator to stop on early break
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
    // Cancel the reader first to prevent unhandled rejections from pending reads
    this.reader.cancel().catch(() => {
      // Expected: may already be closed or errored
    })
    this.abortController.abort()
  }
}
