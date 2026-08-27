import type { ApiContract } from '@lokalise/api-contracts'
import { stringify } from 'fast-querystring'
import type { SSESession } from '../routes/fastifyRouteTypes.ts'
import type { SpiedSSESession, SSESessionSpy } from '../sse/SSESessionSpy.ts'
import { type ParsedSSEEvent, parseSSEBuffer } from '../sse/sseParser.ts'
import { resolveApiSseSchemas, validateApiSseEvent } from './apiSseEventValidation.ts'
import type { ApiSSEEvent } from './apiSseTestTypes.ts'

/**
 * Interface for objects that have a sessionSpy (e.g., SSE controllers in test mode).
 */
export type HasSessionSpy = { connectionSpy: SSESessionSpy }

/** Canonical, on-the-wire spelling of a supported method. */
type NormalizedSSEHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH'

/**
 * HTTP methods supported when connecting to an SSE endpoint.
 *
 * Both spellings are accepted and normalized internally, so the lowercase form
 * used by route contracts (`buildContract({ method: 'post' })`) can be handed
 * over as-is.
 */
export type SSEHttpMethod = NormalizedSSEHttpMethod | Lowercase<NormalizedSSEHttpMethod>

/**
 * Body values `fetch()` sends as-is. Mirrors the DOM `BodyInit`, which is not
 * available as a global type here (the project builds against `lib: ES2023`).
 */
type FetchBody = NonNullable<RequestInit['body']>

/**
 * Options for connecting to an SSE endpoint via HTTP.
 */
export type SSEHttpConnectOptions = {
  /** Query parameters to add to the URL */
  query?: Record<string, string | undefined>
  /** Additional headers to send with the request */
  headers?: Record<string, string>
  /** HTTP method to use, upper- or lowercase (default: 'GET') */
  method?: SSEHttpMethod
  /**
   * Request body.
   *
   * Values `fetch()` can send natively - strings, `URLSearchParams`, `FormData`,
   * `Blob`/`File`, `ArrayBuffer`, typed arrays (`Buffer`, `Uint8Array`, ...) and
   * `ReadableStream` - are passed through untouched. Anything else is
   * JSON-stringified.
   *
   * `content-type: application/json` is defaulted for JSON-stringified and string
   * bodies, unless `headers` already provides a content type. Bodies that describe
   * their own encoding (`URLSearchParams`, `FormData`, `Blob`) are left for
   * `fetch()` to label, so their content type is never overwritten with a wrong one.
   *
   * Requires a non-GET `method`.
   */
  body?: unknown
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
 * Whether `fetch()` can send this value as-is. Everything else is JSON-stringified,
 * so binary and form payloads are not silently mangled into `{}` or `{"0":1}`.
 */
function isFetchBody(body: unknown): body is FetchBody {
  return (
    typeof body === 'string' ||
    body instanceof URLSearchParams ||
    body instanceof FormData ||
    body instanceof Blob ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    body instanceof ReadableStream
  )
}

/**
 * Whether the body carries its own content type, which `fetch()` sets correctly
 * (form encoding, multipart boundary, blob type) and we must not overwrite.
 */
function describesOwnContentType(body: FetchBody): boolean {
  return body instanceof URLSearchParams || body instanceof FormData || body instanceof Blob
}

function hasContentTypeHeader(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((header) => header.toLowerCase() === 'content-type')
}

/**
 * Resolve the value handed to `fetch()` as the request body, defaulting the
 * content type (into `headers`) whenever we are the ones choosing the encoding.
 */
function buildRequestBody(
  body: unknown,
  method: NormalizedSSEHttpMethod,
  headers: Record<string, string>,
): FetchBody | undefined {
  if (body === undefined) {
    return undefined
  }

  if (method === 'GET') {
    throw new Error(
      "SSEHttpClient.connect(): a request body requires a non-GET method. Pass e.g. { method: 'POST', body }.",
    )
  }

  if (isFetchBody(body)) {
    if (!describesOwnContentType(body) && !hasContentTypeHeader(headers)) {
      headers['content-type'] = 'application/json'
    }
    return body
  }

  const serializedBody = JSON.stringify(body)
  if (serializedBody === undefined) {
    throw new Error(
      `SSEHttpClient.connect(): a body of type ${typeof body} cannot be serialized to JSON. Pass a JSON-serializable value, a string, or a body fetch() accepts natively.`,
    )
  }
  if (!hasContentTypeHeader(headers)) {
    headers['content-type'] = 'application/json'
  }
  return serializedBody
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
 * - **Assertions on the wire while the handler is still running** - `connect()`
 *   resolves as soon as headers arrive, so `response.status` / `response.headers`
 *   can be checked before the handler produces its first event
 *
 * GET, POST, PUT and PATCH are all supported (see `method` / `body` in
 * {@link SSEHttpConnectOptions}), so POST SSE endpoints that take a request
 * body can be tested over real HTTP too.
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
  /**
   * The fetch Response object. Available immediately after connect() returns,
   * before any event is consumed, so status and headers can be asserted while
   * the handler is still running.
   *
   * The response body is only locked once events are first consumed, so
   * `response.json()` / `response.text()` still work for endpoints that
   * answered with a regular HTTP response instead of a stream (for example an
   * error raised before `sse.start()`). Read that body *before* calling
   * `close()` - `close()` aborts the request, which rejects any pending or
   * subsequent body read with an `AbortError`.
   */
  readonly response: Response
  private readonly abortController: AbortController
  private readonly responseBody: ReadableStream<Uint8Array> | null
  private streamReader: ReadableStreamDefaultReader<Uint8Array> | undefined
  private readonly decoder = new TextDecoder()
  private buffer = ''
  private closed = false

  private constructor(response: Response, abortController: AbortController) {
    this.response = response
    this.abortController = abortController
    this.responseBody = response.body
  }

  /**
   * Whether the stream is over — the server ended it, or {@link SSEHttpClient.close} was
   * called. A client that reports `true` will yield no further events.
   */
  get isClosed(): boolean {
    return this.closed
  }

  /**
   * Lazily acquire the stream reader, locking the response body on first use.
   *
   * A missing body is reported here rather than from the constructor, so a
   * bodiless response (e.g. `204`) can still be inspected via `response`.
   */
  private get reader(): ReadableStreamDefaultReader<Uint8Array> {
    if (!this.streamReader) {
      if (!this.responseBody) {
        throw new Error(
          `SSE response has no body to stream (status ${this.response.status}). Inspect \`client.response\` instead of consuming events.`,
        )
      }
      this.streamReader = this.responseBody.getReader()
    }
    return this.streamReader
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
   * @param options - Connection options (method, body, query params, headers)
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
   * // POST with a JSON body (content-type defaults to application/json)
   * const client = await SSEHttpClient.connect(
   *   'http://localhost:3000',
   *   '/api/chat/completions',
   *   { method: 'POST', body: { message: 'Hello', stream: true } }
   * )
   * // Headers are on the wire before the handler finished its slow work
   * expect(client.response.status).toBe(200)
   * expect(client.response.headers.get('content-type')).toContain('text/event-stream')
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

    // Normalize once - contracts spell methods in lowercase, the wire and Node use uppercase
    const method = (options?.method ?? 'GET').toUpperCase() as NormalizedSSEHttpMethod
    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      ...options?.headers,
    }

    const body = buildRequestBody(options?.body, method, headers)

    // Connect - fetch() returns when headers are received
    const abortController = new AbortController()
    const requestInit: RequestInit = {
      method,
      headers,
      body,
      signal: abortController.signal,
    }
    if (body instanceof ReadableStream) {
      // A streamed request body has to declare half-duplex explicitly, or fetch() rejects it
      ;(requestInit as RequestInit & { duplex?: 'half' }).duplex = 'half'
    }
    const response = await fetch(`${baseUrl}${pathWithQuery}`, requestInit)

    const client = new SSEHttpClient(response, abortController)

    // If awaitServerConnection is specified, wait for server-side registration
    if (options && 'awaitServerConnection' in options && options.awaitServerConnection) {
      const awaitOptions = options.awaitServerConnection
      const waitOptions = {
        timeout: awaitOptions.timeout ?? 5000,
        predicate: (conn: SpiedSSESession) =>
          conn.request.url === pathWithQuery && conn.request.method.toUpperCase() === method,
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
   * Async generator that yields events typed and validated against an `ApiContract`.
   *
   * The contract-aware counterpart of {@link SSEHttpClient.events}: each event is JSON-parsed,
   * checked against the contract's `sseResponse` / `sseBody` schema for its name, and typed as
   * a member of the contract's discriminated union — the same events `injectApiSSE().events()`
   * returns, so an assertion reads the same on either path.
   *
   * {@link connectApiSSE} is usually the better entry point: it also resolves the path, method
   * and body from the contract. Reach for this method when the connection already exists — one
   * opened with `awaitServerConnection`, say.
   *
   * @param contract - Contract built with `defineApiContract`, declaring the SSE events
   * @param signal - Optional `AbortSignal` to stop the generator early
   *
   * @throws if the contract declares no SSE response, if an event name it doesn't declare
   *   arrives, or if a payload fails its schema
   *
   * @example
   * ```typescript
   * for await (const event of client.apiEvents(lqaSegmentContract)) {
   *   if (event.event === 'issue') expect(event.data.severity).toBe('minor')
   * }
   * ```
   */
  async *apiEvents<Contract extends ApiContract>(
    contract: Contract,
    signal?: AbortSignal,
  ): AsyncGenerator<ApiSSEEvent<Contract>, void, unknown> {
    const schemaByEventName = resolveApiSseSchemas(contract, 'apiEvents()')
    for await (const event of this.events(signal)) {
      yield validateApiSseEvent<Contract>(schemaByEventName, event, 'apiEvents()')
    }
  }

  /**
   * Collect events typed and validated against an `ApiContract`, until a count is reached or
   * a predicate matches.
   *
   * The contract-aware counterpart of {@link SSEHttpClient.collectEvents}; the predicate sees
   * the typed event, so it can narrow on `event.event` and read `event.data` without a cast.
   *
   * @param contract - Contract built with `defineApiContract`, declaring the SSE events
   * @param countOrPredicate - Number of events to collect, or a predicate that ends collection
   *   (the matching event is included)
   * @param timeout - Maximum time to wait in milliseconds (default: 5000)
   *
   * @example
   * ```typescript
   * const events = await client.collectApiEvents(contract, (e) => e.event === 'review')
   * expect(events.at(-1)?.data).toMatchObject({ score: 5 })
   * ```
   */
  async collectApiEvents<Contract extends ApiContract>(
    contract: Contract,
    countOrPredicate: number | ((event: ApiSSEEvent<Contract>) => boolean),
    timeout?: number,
  ): Promise<ApiSSEEvent<Contract>[]> {
    const schemaByEventName = resolveApiSseSchemas(contract, 'collectApiEvents()')
    // A predicate sees every event as it arrives, and the collected ones are returned typed:
    // memoizing keeps each event validated once instead of twice, and — more importantly —
    // hands the caller the very object its predicate inspected.
    const validated = new Map<ParsedSSEEvent, ApiSSEEvent<Contract>>()
    const validate = (event: ParsedSSEEvent): ApiSSEEvent<Contract> => {
      const cached = validated.get(event)
      if (cached) {
        return cached
      }
      const parsed = validateApiSseEvent<Contract>(schemaByEventName, event, 'collectApiEvents()')
      validated.set(event, parsed)
      return parsed
    }

    const collected = await this.collectEvents(
      typeof countOrPredicate === 'number'
        ? countOrPredicate
        : (event) => countOrPredicate(validate(event)),
      timeout,
    )
    return collected.map(validate)
  }

  /**
   * Close the connection from the client side.
   *
   * This aborts the underlying fetch request. Call this when done
   * consuming events to clean up resources.
   *
   * Aborting also discards any unread response body, so for a non-stream
   * response (an error raised before `sse.start()`, say) read
   * `response.json()` / `response.text()` before calling this.
   */
  close(): void {
    this.closed = true
    // Cancel the reader first to prevent unhandled rejections from pending reads.
    // Only touch it if events were actually consumed - acquiring it here would
    // lock a body the caller may still want to read as JSON/text.
    this.streamReader?.cancel().catch(() => {
      // Expected: may already be closed or errored
    })
    this.abortController.abort()
  }
}
