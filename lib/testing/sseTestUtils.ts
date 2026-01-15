import FastifySSEPlugin from '@fastify/sse'
import fastify, { type FastifyInstance } from 'fastify'
import type { z } from 'zod'
import type { AnySSERouteDefinition, SSERouteDefinition } from '../sse/sseContracts.ts'
import type { SSEMessage } from '../sse/sseTypes.ts'

/**
 * Parsed SSE event from the stream.
 */
export type ParsedSSEEvent = {
  id?: string
  event?: string
  data: string
  retry?: number
}

/**
 * Represents an active SSE test connection.
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
}

/**
 * Options for establishing an SSE connection.
 */
export type SSEConnectOptions = {
  headers?: Record<string, string>
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH'
  body?: unknown
}

/**
 * SSE test client for integration testing.
 */
export interface SSETestClient {
  /**
   * Establish a GET SSE connection.
   * @param url - The URL to connect to
   * @param options - Connection options
   */
  connect(
    url: string,
    options?: Omit<SSEConnectOptions, 'method' | 'body'>,
  ): Promise<SSETestConnection>

  /**
   * Establish a POST/PUT/PATCH SSE connection with a request body.
   * @param url - The URL to connect to
   * @param body - The request body
   * @param options - Connection options
   */
  connectWithBody(
    url: string,
    body: unknown,
    options?: Omit<SSEConnectOptions, 'body'>,
  ): Promise<SSETestConnection>
}

/**
 * Parse SSE events from a text stream.
 */
export function parseSSEEvents(text: string): ParsedSSEEvent[] {
  const events: ParsedSSEEvent[] = []
  const lines = text.split('\n')

  let currentEvent: Partial<ParsedSSEEvent> = {}
  let dataLines: string[] = []

  for (const line of lines) {
    if (line.startsWith('id:')) {
      currentEvent.id = line.slice(3).trim()
    } else if (line.startsWith('event:')) {
      currentEvent.event = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim())
    } else if (line.startsWith('retry:')) {
      currentEvent.retry = Number.parseInt(line.slice(6).trim(), 10)
    } else if (line === '' && dataLines.length > 0) {
      // Empty line marks end of event
      events.push({
        ...currentEvent,
        data: dataLines.join('\n'),
      } as ParsedSSEEvent)
      currentEvent = {}
      dataLines = []
    }
    // Skip comment lines (starting with :)
  }

  // Handle case where stream doesn't end with double newline
  if (dataLines.length > 0) {
    events.push({
      ...currentEvent,
      data: dataLines.join('\n'),
    } as ParsedSSEEvent)
  }

  return events
}

/**
 * Create an SSE test connection from a Fastify inject response.
 */
function createTestConnection(
  response: {
    statusCode: number
    headers: Record<string, string | string[] | undefined>
    body: string
  },
  abortController: AbortController,
): SSETestConnection {
  const receivedEvents: ParsedSSEEvent[] = []
  let closed = false

  // Parse initial events from response body
  if (response.body) {
    const events = parseSSEEvents(response.body)
    receivedEvents.push(...events)
  }

  return {
    async waitForEvent(eventName: string, timeout = 5000): Promise<ParsedSSEEvent> {
      const startTime = Date.now()

      while (Date.now() - startTime < timeout) {
        const event = receivedEvents.find((e) => e.event === eventName)
        if (event) {
          return event
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }

      throw new Error(`Timeout waiting for event: ${eventName}`)
    },

    async waitForEvents(count: number, timeout = 5000): Promise<ParsedSSEEvent[]> {
      const startTime = Date.now()

      while (Date.now() - startTime < timeout) {
        if (receivedEvents.length >= count) {
          return receivedEvents.slice(0, count)
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }

      throw new Error(`Timeout waiting for ${count} events, received ${receivedEvents.length}`)
    },

    getReceivedEvents(): ParsedSSEEvent[] {
      return [...receivedEvents]
    },

    close(): void {
      if (!closed) {
        closed = true
        abortController.abort()
      }
    },

    isClosed(): boolean {
      return closed
    },

    getStatusCode(): number {
      return response.statusCode
    },

    getHeaders(): Record<string, string | string[] | undefined> {
      return response.headers
    },
  }
}

/**
 * Create an SSE test client for integration testing.
 *
 * @param app - Fastify instance to test against
 * @returns SSE test client
 *
 * @example
 * ```typescript
 * const client = createSSETestClient(app)
 *
 * // GET SSE connection
 * const conn = await client.connect('/api/notifications/stream', {
 *   headers: { authorization: 'Bearer token' },
 * })
 *
 * // POST SSE connection (OpenAI-style)
 * const conn = await client.connectWithBody('/api/ai/chat', {
 *   model: 'gpt-4',
 *   messages: [{ role: 'user', content: 'Hello' }],
 * })
 *
 * // Wait for events
 * const event = await conn.waitForEvent('notification')
 * const events = await conn.waitForEvents(3)
 *
 * // Cleanup
 * conn.close()
 * ```
 */
// biome-ignore lint/suspicious/noExplicitAny: Fastify instance types are complex
export function createSSETestClient(app: FastifyInstance<any, any, any, any>): SSETestClient {
  return {
    async connect(
      url: string,
      options?: Omit<SSEConnectOptions, 'method' | 'body'>,
    ): Promise<SSETestConnection> {
      const abortController = new AbortController()

      const response = await app.inject({
        method: 'GET',
        url,
        headers: {
          accept: 'text/event-stream',
          ...options?.headers,
        },
      })

      return createTestConnection(
        {
          statusCode: response.statusCode,
          headers: response.headers as Record<string, string | string[] | undefined>,
          body: response.body,
        },
        abortController,
      )
    },

    async connectWithBody(
      url: string,
      body: unknown,
      options?: Omit<SSEConnectOptions, 'body'>,
    ): Promise<SSETestConnection> {
      const abortController = new AbortController()

      const response = await app.inject({
        method: options?.method ?? 'POST',
        url,
        headers: {
          accept: 'text/event-stream',
          'content-type': 'application/json',
          ...options?.headers,
        },
        payload: JSON.stringify(body),
      })

      return createTestConnection(
        {
          statusCode: response.statusCode,
          headers: response.headers as Record<string, string | string[] | undefined>,
          body: response.body,
        },
        abortController,
      )
    },
  }
}

/**
 * Helper to create a mock SSE message for testing.
 */
export function createMockSSEMessage<T>(data: T, options?: Partial<SSEMessage<T>>): SSEMessage<T> {
  return {
    data,
    ...options,
  }
}

// ============================================================================
// Contract-aware SSE inject helpers
// ============================================================================

/**
 * Options for injectSSE (GET SSE routes).
 */
export type InjectSSEOptions<Contract extends AnySSERouteDefinition> = {
  params?: z.infer<Contract['params']>
  query?: z.infer<Contract['query']>
  headers?: z.infer<Contract['requestHeaders']>
}

/**
 * Options for injectPayloadSSE (POST/PUT/PATCH SSE routes).
 */
export type InjectPayloadSSEOptions<Contract extends AnySSERouteDefinition> = {
  params?: z.infer<Contract['params']>
  query?: z.infer<Contract['query']>
  headers?: z.infer<Contract['requestHeaders']>
  body: Contract['body'] extends z.ZodTypeAny ? z.infer<Contract['body']> : never
}

/**
 * SSE response data.
 */
export type SSEResponse = {
  statusCode: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

/**
 * Result of an SSE inject call.
 *
 * Note: Fastify's inject() waits for the full response, so these helpers
 * work best for streaming that completes (OpenAI-style). For long-lived
 * SSE connections, use `connectSSE` with a real HTTP server instead.
 */
export type InjectSSEResult = {
  /**
   * Resolves when the response completes with the full SSE body.
   * Parse the body with `parseSSEEvents()` to get individual events.
   */
  closed: Promise<SSEResponse>
}

/**
 * Build URL from contract path and params.
 */
function buildUrl<Contract extends AnySSERouteDefinition>(
  contract: Contract,
  params?: Record<string, string>,
  query?: Record<string, unknown>,
): string {
  let url = contract.path

  // Substitute path params
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url = url.replace(`:${key}`, encodeURIComponent(String(value)))
    }
  }

  // Add query string
  if (query && Object.keys(query).length > 0) {
    const searchParams = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) {
        searchParams.append(key, String(value))
      }
    }
    const queryString = searchParams.toString()
    if (queryString) {
      url = `${url}?${queryString}`
    }
  }

  return url
}

/**
 * Inject a GET SSE request using a contract definition.
 *
 * Best for testing SSE endpoints that complete (streaming responses).
 * For long-lived connections, use `connectSSE` with a real HTTP server.
 *
 * @param app - Fastify instance
 * @param contract - SSE route contract
 * @param options - Request options (params, query, headers)
 *
 * @example
 * ```typescript
 * const { closed } = injectSSE(app, streamContract, {
 *   query: { userId: 'user-123' },
 * })
 * const result = await closed
 * const events = parseSSEEvents(result.body)
 * ```
 */
export function injectSSE<
  Contract extends SSERouteDefinition<
    'GET',
    string,
    z.ZodTypeAny,
    z.ZodTypeAny,
    z.ZodTypeAny,
    undefined,
    Record<string, z.ZodTypeAny>
  >,
>(
  // biome-ignore lint/suspicious/noExplicitAny: Fastify instance types are complex
  app: FastifyInstance<any, any, any, any>,
  contract: Contract,
  options?: InjectSSEOptions<Contract>,
): InjectSSEResult {
  const url = buildUrl(
    contract,
    options?.params as Record<string, string> | undefined,
    options?.query as Record<string, unknown> | undefined,
  )

  // Start the request - this promise resolves when connection closes
  const closed = app
    .inject({
      method: 'GET',
      url,
      headers: {
        accept: 'text/event-stream',
        ...(options?.headers as Record<string, string> | undefined),
      },
    })
    .then((res) => ({
      statusCode: res.statusCode,
      headers: res.headers as Record<string, string | string[] | undefined>,
      body: res.body,
    }))

  return { closed }
}

/**
 * Inject a POST/PUT/PATCH SSE request using a contract definition.
 *
 * This helper is designed for testing OpenAI-style streaming APIs where
 * the request includes a body and the response streams events.
 *
 * @param app - Fastify instance
 * @param contract - SSE route contract with body
 * @param options - Request options (params, query, headers, body)
 *
 * @example
 * ```typescript
 * // Fire the SSE request
 * const { connected, closed } = injectPayloadSSE(app, chatCompletionContract, {
 *   body: { message: 'Hello', stream: true },
 *   headers: { authorization: 'Bearer token' },
 * })
 *
 * // Wait for connection to be established (optional)
 * await connected
 *
 * // Wait for streaming to complete and get full response
 * const result = await closed
 * const events = parseSSEEvents(result.body)
 *
 * expect(events).toContainEqual(
 *   expect.objectContaining({ event: 'chunk' })
 * )
 * ```
 */
export function injectPayloadSSE<
  Contract extends SSERouteDefinition<
    'POST' | 'PUT' | 'PATCH',
    string,
    z.ZodTypeAny,
    z.ZodTypeAny,
    z.ZodTypeAny,
    z.ZodTypeAny,
    Record<string, z.ZodTypeAny>
  >,
>(
  // biome-ignore lint/suspicious/noExplicitAny: Fastify instance types are complex
  app: FastifyInstance<any, any, any, any>,
  contract: Contract,
  options: InjectPayloadSSEOptions<Contract>,
): InjectSSEResult {
  const url = buildUrl(
    contract,
    options.params as Record<string, string> | undefined,
    options.query as Record<string, unknown> | undefined,
  )

  const closed = app
    .inject({
      method: contract.method,
      url,
      headers: {
        accept: 'text/event-stream',
        'content-type': 'application/json',
        ...(options.headers as Record<string, string> | undefined),
      },
      payload: JSON.stringify(options.body),
    })
    .then((res) => ({
      statusCode: res.statusCode,
      headers: res.headers as Record<string, string | string[] | undefined>,
      body: res.body,
    }))

  return { closed }
}

/**
 * Helper to wait for a condition with timeout.
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeout = 5000,
  interval = 10,
): Promise<void> {
  const startTime = Date.now()

  while (Date.now() - startTime < timeout) {
    if (await condition()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, interval))
  }

  throw new Error('Timeout waiting for condition')
}

// ============================================================================
// Real HTTP SSE client for long-lived connection testing
// ============================================================================

/**
 * An active SSE connection for testing long-lived streams.
 */
export interface SSEClientConnection {
  /** The fetch Response object (headers already received = connection established) */
  response: Response

  /**
   * Async iterator that yields parsed SSE events as they arrive.
   * Completes when the connection closes.
   */
  events: () => AsyncGenerator<ParsedSSEEvent, void, unknown>

  /**
   * Collect events until a condition is met or count is reached.
   * @param countOrPredicate - Number of events to collect, or predicate to stop
   * @param timeout - Timeout in milliseconds (default: 5000)
   */
  collectEvents(
    countOrPredicate: number | ((event: ParsedSSEEvent) => boolean),
    timeout?: number,
  ): Promise<ParsedSSEEvent[]>

  /**
   * Close the connection from the client side.
   */
  close(): void
}

/**
 * Connect to an SSE endpoint using real HTTP.
 *
 * Use this for testing long-lived SSE connections where the server sends
 * events incrementally. The returned connection provides an async iterator
 * for consuming events as they arrive.
 *
 * Requires a real HTTP server (use `app.listen()` before calling).
 *
 * @param baseUrl - Base URL of the server (e.g., 'http://localhost:3000')
 * @param path - SSE endpoint path (e.g., '/api/stream')
 * @param options - Request options
 *
 * @example
 * ```typescript
 * // Start real server
 * await app.listen({ port: 0 })
 * const baseUrl = `http://localhost:${app.server.address().port}`
 *
 * // Connect to SSE endpoint
 * const connection = await connectSSE(baseUrl, '/api/notifications', {
 *   query: { userId: 'user-123' },
 * })
 *
 * // Connection is established (headers received)
 * expect(connection.response.ok).toBe(true)
 *
 * // Send events from server via controller
 * controller.sendEvent(connectionId, { event: 'msg', data: { text: 'Hello' } })
 *
 * // Collect events
 * const events = await connection.collectEvents(3)
 * // or use async iterator:
 * for await (const event of connection.events()) {
 *   console.log(event)
 *   if (event.event === 'done') break
 * }
 *
 * connection.close()
 * ```
 */

/**
 * Parse SSE events from a buffer string.
 * Returns parsed events and the remaining incomplete data.
 */
function parseSSEBuffer(buffer: string): { events: ParsedSSEEvent[]; remaining: string } {
  const events: ParsedSSEEvent[] = []
  const lines = buffer.split('\n')

  let currentEvent: Partial<ParsedSSEEvent> = {}
  let dataLines: string[] = []
  let lastCompleteEventEnd = 0
  let currentPosition = 0

  for (const line of lines) {
    currentPosition += line.length + 1 // +1 for the \n

    if (line.startsWith('id:')) {
      currentEvent.id = line.slice(3).trim()
    } else if (line.startsWith('event:')) {
      currentEvent.event = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim())
    } else if (line.startsWith('retry:')) {
      currentEvent.retry = Number.parseInt(line.slice(6).trim(), 10)
    } else if (line === '' && dataLines.length > 0) {
      // Complete event found
      events.push({
        ...currentEvent,
        data: dataLines.join('\n'),
      } as ParsedSSEEvent)
      currentEvent = {}
      dataLines = []
      lastCompleteEventEnd = currentPosition
    }
  }

  // Return remaining incomplete data
  const remaining = dataLines.length > 0 ? buffer.slice(lastCompleteEventEnd) : ''
  return { events, remaining }
}

export async function connectSSE(
  baseUrl: string,
  path: string,
  options?: {
    query?: Record<string, string | undefined>
    headers?: Record<string, string>
  },
): Promise<SSEClientConnection> {
  // Build URL with query params
  let url = `${baseUrl}${path}`
  if (options?.query) {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== undefined) {
        params.append(key, value)
      }
    }
    const queryString = params.toString()
    if (queryString) {
      url = `${url}?${queryString}`
    }
  }

  // Connect - fetch() returns when headers are received
  const abortController = new AbortController()
  const response = await fetch(url, {
    headers: {
      Accept: 'text/event-stream',
      ...options?.headers,
    },
    signal: abortController.signal,
  })

  if (!response.body) {
    throw new Error('SSE response has no body')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let closed = false

  // Async generator for events
  async function* events(): AsyncGenerator<ParsedSSEEvent, void, unknown> {
    while (!closed) {
      const { done, value } = await reader.read()
      if (done) {
        closed = true
        break
      }

      buffer += decoder.decode(value, { stream: true })

      // Parse complete events from buffer and get remaining buffer
      const parseResult = parseSSEBuffer(buffer)
      buffer = parseResult.remaining

      // Yield each parsed event
      for (const event of parseResult.events) {
        yield event
      }
    }
  }

  return {
    response,

    events,

    async collectEvents(
      countOrPredicate: number | ((event: ParsedSSEEvent) => boolean),
      timeout = 5000,
    ): Promise<ParsedSSEEvent[]> {
      const collected: ParsedSSEEvent[] = []
      const startTime = Date.now()
      const isCount = typeof countOrPredicate === 'number'

      for await (const event of events()) {
        collected.push(event)

        if (isCount && collected.length >= countOrPredicate) {
          break
        }
        if (!isCount && countOrPredicate(event)) {
          break
        }
        if (Date.now() - startTime > timeout) {
          throw new Error(`Timeout collecting events (got ${collected.length})`)
        }
      }

      return collected
    },

    close() {
      closed = true
      abortController.abort()
    },
  }
}

/**
 * Options for creating an SSE test server.
 */
export type CreateSSETestServerOptions<T> = {
  /**
   * Configure the Fastify instance before SSE routes are registered.
   * Use this to add plugins, validators, etc.
   */
  configureApp?: (app: FastifyInstance) => void | Promise<void>
  /**
   * Custom setup function that returns resources to be cleaned up.
   * The returned value will be passed to the cleanup function.
   */
  setup?: () => T | Promise<T>
}

/**
 * SSE test server instance with cleanup support.
 */
export type SSETestServer<T = undefined> = {
  /** The Fastify instance */
  app: FastifyInstance
  /** Base URL for the running server (e.g., "http://localhost:3000") */
  baseUrl: string
  /** Custom resources from setup function */
  resources: T
  /** Close the server and cleanup resources */
  close: () => Promise<void>
}

/**
 * Create a test server for e2e SSE testing.
 *
 * This helper simplifies SSE e2e test setup by:
 * - Creating and configuring a Fastify instance
 * - Starting a real HTTP server on a random port
 * - Providing a base URL for making requests
 * - Handling cleanup on close
 *
 * @example
 * ```typescript
 * // Simple usage
 * const server = await createSSETestServer(async (app) => {
 *   // Register SSE routes
 *   context.registerSSERoutes(app)
 * })
 *
 * const connection = await connectSSE(server.baseUrl, '/api/stream')
 * // ... test SSE events
 *
 * await server.close()
 * ```
 *
 * @example
 * ```typescript
 * // With custom setup and resources
 * const server = await createSSETestServer(
 *   async (app) => {
 *     context.registerSSERoutes(app)
 *   },
 *   {
 *     configureApp: async (app) => {
 *       app.setValidatorCompiler(validatorCompiler)
 *     },
 *     setup: async () => {
 *       const container = createContainer()
 *       const context = new DIContext(container, {}, {})
 *       return { context }
 *     },
 *   }
 * )
 *
 * // Access custom resources
 * const controller = server.resources.context.diContainer.cradle.myController
 *
 * await server.close()
 * ```
 */
export async function createSSETestServer(
  registerRoutes: (app: FastifyInstance) => void | Promise<void>,
): Promise<SSETestServer<undefined>>
export async function createSSETestServer<T>(
  registerRoutes: (app: FastifyInstance) => void | Promise<void>,
  options: CreateSSETestServerOptions<T>,
): Promise<SSETestServer<T>>
export async function createSSETestServer<T = undefined>(
  registerRoutes: (app: FastifyInstance) => void | Promise<void>,
  options?: CreateSSETestServerOptions<T>,
): Promise<SSETestServer<T>> {
  // Create Fastify app
  const app = fastify()

  // Register SSE plugin (type assertion needed due to @fastify/sse's module.exports pattern)
  await app.register(FastifySSEPlugin as unknown as Parameters<typeof app.register>[0])

  // Run custom configuration
  if (options?.configureApp) {
    await options.configureApp(app)
  }

  // Setup custom resources
  const resources = options?.setup ? await options.setup() : (undefined as T)

  // Register routes
  await registerRoutes(app)

  // Start the server on random port
  await app.listen({ port: 0 })
  const address = app.server.address()
  const baseUrl = typeof address === 'string' ? address : `http://localhost:${address?.port}`

  return {
    app,
    baseUrl,
    resources,
    async close() {
      await app.close()
    },
  }
}
