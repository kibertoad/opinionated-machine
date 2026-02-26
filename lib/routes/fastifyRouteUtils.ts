import { randomUUID } from 'node:crypto'
import type { SSEReplyInterface } from '@fastify/sse'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { z } from 'zod'
import type { DualModeType } from '../dualmode/dualModeTypes.ts'
import type { SSERoomManager } from '../sse/rooms/SSERoomManager.ts'
import type { SSERoomOperations } from '../sse/rooms/types.ts'
import type { SSEEventSchemas, SSEEventSender, SSELogger, SSEMessage } from '../sse/sseTypes.ts'
import type {
  SSEContext,
  SSERespondResult,
  SSESession,
  SSESessionMode,
  SSEStartOptions,
  SSEStreamMessage,
} from './fastifyRouteTypes.ts'

/**
 * FastifyReply extended with SSE capabilities from @fastify/sse.
 */
export type SSEReply = FastifyReply & { sse: SSEReplyInterface }

/**
 * Minimal interface for SSE controller methods used by route utilities.
 * This allows shared utilities to work with both SSE and dual-mode controllers.
 */
export type SSEControllerLike = {
  _sendEventRaw(connectionId: string, message: SSEMessage): Promise<boolean>
  registerConnection(connection: SSESession): void
  unregisterConnection(connectionId: string): void
  /** Room manager, if rooms are enabled */
  _internalRoomManager?: SSERoomManager
}

/**
 * Reason why the SSE connection was closed.
 * - 'server': Server explicitly called closeConnection() or returned success('disconnect')
 * - 'client': Client closed the connection (EventSource.close(), navigated away, etc.)
 */
export type SSECloseReason = 'server' | 'client'

/**
 * Options for SSE connection lifecycle hooks.
 */
export type SSELifecycleOptions<TConnection = SSESession> = {
  onConnect?: (connection: TConnection) => void | Promise<void>
  /**
   * Called when the SSE connection closes for any reason (client disconnect,
   * network failure, or server explicitly closing via closeConnection()).
   *
   * @param connection - The connection that was closed
   * @param reason - Why the connection was closed:
   *   - 'server': Server explicitly closed (closeConnection() or success('disconnect'))
   *   - 'client': Client closed (EventSource.close(), navigation, network failure)
   *
   * Use this for cleanup like unsubscribing from events or removing from tracking.
   */
  onClose?: (connection: TConnection, reason: SSECloseReason) => void | Promise<void>
  onReconnect?: (
    connection: TConnection,
    lastEventId: string,
  ) => Iterable<SSEMessage> | AsyncIterable<SSEMessage> | void | Promise<void>
  logger?: SSELogger
}

/**
 * Extract Fastify path template from pathResolver.
 *
 * This function creates placeholder params with ':paramName' values and calls
 * the pathResolver to generate a Fastify-compatible path template.
 *
 * @example
 * ```typescript
 * // pathResolver: (p) => `/users/${p.userId}/posts/${p.postId}`
 * // paramsSchema: z.object({ userId: z.string(), postId: z.string() })
 * // Result: '/users/:userId/posts/:postId'
 * ```
 */
export function extractPathTemplate<Params>(
  pathResolver: (params: Params) => string,
  paramsSchema: z.ZodObject<z.ZodRawShape>,
): string {
  // Create placeholder params object with ':paramName' values
  const placeholderParams: Record<string, string> = {}
  for (const key of Object.keys(paramsSchema.shape)) {
    placeholderParams[key] = `:${key}`
  }
  return pathResolver(placeholderParams as unknown as Params)
}

/**
 * Check if a value is an Error-like object (cross-realm safe).
 * Uses duck typing instead of instanceof for reliability across realms.
 */
export function isErrorLike(err: unknown): err is { message: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'message' in err &&
    typeof (err as { message: unknown }).message === 'string'
  )
}

/**
 * Check if an error has a valid httpStatusCode property (like PublicNonRecoverableError).
 * Uses duck typing instead of instanceof for reliability across realms.
 * Validates the status code is a finite integer within valid HTTP range (100-599).
 */
export function hasHttpStatusCode(err: unknown): err is { httpStatusCode: number } {
  if (typeof err !== 'object' || err === null || !('httpStatusCode' in err)) {
    return false
  }
  const statusCode = (err as { httpStatusCode: unknown }).httpStatusCode
  return (
    typeof statusCode === 'number' &&
    Number.isFinite(statusCode) &&
    Number.isInteger(statusCode) &&
    statusCode >= 100 &&
    statusCode <= 599
  )
}

/**
 * Send replay events from either sync or async iterables.
 */
export async function sendReplayEvents(
  sseReply: SSEReply,
  replayEvents: Iterable<SSEMessage> | AsyncIterable<SSEMessage>,
): Promise<void> {
  // biome-ignore lint/suspicious/noExplicitAny: checking for iterator symbols
  const iterable = replayEvents as any
  if (typeof iterable[Symbol.asyncIterator] === 'function') {
    for await (const event of replayEvents as AsyncIterable<SSEMessage>) {
      await sseReply.sse.send(event)
    }
  } else if (typeof iterable[Symbol.iterator] === 'function') {
    for (const event of replayEvents as Iterable<SSEMessage>) {
      await sseReply.sse.send(event)
    }
  }
}

/**
 * Handle Last-Event-ID reconnection by replaying missed events.
 */
export async function handleReconnection(
  sseReply: SSEReply,
  connection: SSESession,
  lastEventId: string,
  options: SSELifecycleOptions | undefined,
  logPrefix = 'SSE',
): Promise<void> {
  if (!options?.onReconnect) return

  try {
    const replayEvents = await options.onReconnect(connection, lastEventId)
    if (replayEvents) {
      await sendReplayEvents(sseReply, replayEvents)
    }
  } catch (err) {
    options?.logger?.error({ err, lastEventId }, `Error in ${logPrefix} onReconnect handler`)
  }
}

/**
 * Send error event to client and close connection gracefully.
 */
export async function handleSSEError(
  sseReply: SSEReply,
  controller: SSEControllerLike,
  connectionId: string,
  err: unknown,
): Promise<void> {
  // Send error event to client (bypasses validation since this is framework-level)
  try {
    await sseReply.sse.send({
      event: 'error',
      data: { message: isErrorLike(err) ? err.message : 'Internal server error' },
    })
  } catch {
    // Connection might already be closed, ignore
  }

  // Close the connection gracefully
  try {
    sseReply.sse.close()
  } catch {
    // Connection may already be closed
  }
  controller.unregisterConnection(connectionId)
}

/**
 * Result of setting up an SSE connection.
 */
export type SSESessionSetupResult<Events extends SSEEventSchemas = SSEEventSchemas> = {
  connectionId: string
  connection: SSESession<Events>
  connectionClosed: Promise<void>
  sseReply: SSEReply
}

/**
 * Create room operations object for the session.
 * If room manager is not available, returns no-op functions.
 */
function createRoomOperations(
  connectionId: string,
  roomManager: SSERoomManager | undefined,
): SSERoomOperations {
  if (!roomManager) {
    // Return no-op operations when rooms are not enabled
    return {
      join: () => {},
      leave: () => {},
    }
  }

  return {
    join: (room) => roomManager.join(connectionId, room),
    leave: (room) => roomManager.leave(connectionId, room),
  }
}

/**
 * Create an SSE connection object with all helpers.
 * This is an internal helper used by createSSEContext.
 *
 * @internal
 */
function createSSESessionInternal<Events extends SSEEventSchemas, Context = unknown>(
  connectionId: string,
  request: FastifyRequest,
  reply: FastifyReply,
  sseReply: SSEReply,
  eventSchemas: Events,
  controller: SSEControllerLike,
  initialContext?: Context,
  reconnectionPromise?: Promise<void>,
): SSESession<Events, Context> {
  // Create type-safe event sender for the handler
  // If reconnection is in progress, wait for it before sending to maintain event ordering
  const send: SSEEventSender<Events> = async (eventName, data, sendOptions) => {
    if (reconnectionPromise) {
      await reconnectionPromise
    }
    return controller._sendEventRaw(connectionId, {
      event: eventName,
      data,
      id: sendOptions?.id,
      retry: sendOptions?.retry,
    })
  }

  // Create sendStream function that validates and sends messages from async iterable
  const sendStream = async (messages: AsyncIterable<SSEStreamMessage<Events>>): Promise<void> => {
    for await (const message of messages) {
      // Validate against schema if available
      const schema = eventSchemas[message.event]
      if (schema) {
        const result = schema.safeParse(message.data)
        if (!result.success) {
          throw new Error(
            `SSE event validation failed for '${message.event}': ${result.error.message}`,
          )
        }
      }
      // Send the validated message
      await sseReply.sse.send({
        event: message.event,
        data: message.data,
        id: message.id,
        retry: message.retry,
      })
    }
  }

  // Create room operations
  const rooms = createRoomOperations(connectionId, controller._internalRoomManager)

  return {
    id: connectionId,
    request,
    reply,
    context: (initialContext ?? {}) as Context,
    connectedAt: new Date(),
    send,
    isConnected: () => sseReply.sse.isConnected,
    getStream: () => sseReply.sse.stream(),
    sendStream,
    rooms,
    eventSchemas,
  }
}

/**
 * Result of creating an SSE context.
 */
export type SSEContextResult<Events extends SSEEventSchemas = SSEEventSchemas> = {
  sseContext: SSEContext<Events>
  /** Promise that resolves when client disconnects */
  connectionClosed: Promise<void>
  /** The SSE reply object for advanced operations */
  sseReply: SSEReply
  /** Get the connection if streaming was started */
  getConnection: () => SSESession<Events> | undefined
  /** Get the connection ID if streaming was started */
  getConnectionId: () => string | undefined
  /** Check if streaming was started */
  isStarted: () => boolean
  /** Check if a response was sent via sse.respond() */
  hasResponse: () => boolean
  /** Get the response data if sse.respond() was called */
  getResponseData: () => { code: number; body: unknown } | undefined
  /** Get the session mode if streaming was started */
  getMode: () => SSESessionMode | undefined
}

/**
 * Create an SSEContext for deferred header sending.
 *
 * This factory creates the `sse` parameter passed to SSE handlers, allowing:
 * - Validation before headers are sent
 * - Proper HTTP error responses (404, 422, etc.)
 * - Explicit streaming start via `sse.start()`
 *
 * @param controller - The SSE controller for connection management
 * @param request - The Fastify request
 * @param reply - The Fastify reply
 * @param eventSchemas - Event schemas for type-safe event sending
 * @param options - Lifecycle hooks and options
 * @param logPrefix - Prefix for log messages
 *
 * @returns SSEContext result with context object and state accessors
 */
export function createSSEContext<Events extends SSEEventSchemas>(
  controller: SSEControllerLike,
  request: FastifyRequest,
  reply: FastifyReply,
  eventSchemas: Events,
  options: SSELifecycleOptions | undefined,
  logPrefix = 'SSE',
): SSEContextResult<Events> {
  const connectionId = randomUUID()
  const sseReply = reply as SSEReply

  // State tracking
  let started = false
  let responseSent = false
  let headersSent = false
  let connection: SSESession<Events> | undefined
  let sessionMode: SSESessionMode | undefined
  let onCloseCalled = false
  let responseData: { code: number; body: unknown } | undefined

  // Helper to call onClose exactly once
  const callOnClose = async (reason: SSECloseReason) => {
    if (onCloseCalled || !connection) return
    onCloseCalled = true
    try {
      if (options?.onClose) {
        await options.onClose(connection as unknown as SSESession, reason)
      }
    } catch (err) {
      options?.logger?.error({ err }, `Error in ${logPrefix} onClose handler`)
    }
  }

  // Helper to fire onConnect hook (not awaited, errors logged)
  const fireOnConnect = (conn: SSESession<Events>) => {
    if (!options?.onConnect) return
    try {
      const maybePromise = options.onConnect(conn as unknown as SSESession)
      if (maybePromise && typeof maybePromise.catch === 'function') {
        maybePromise.catch((err: unknown) => {
          options?.logger?.error({ err }, `Error in ${logPrefix} onConnect handler`)
        })
      }
    } catch (err) {
      options?.logger?.error({ err }, `Error in ${logPrefix} onConnect handler`)
    }
  }

  // Create a promise that will resolve when the connection closes
  const connectionClosed = new Promise<void>((resolve) => {
    request.socket.on('close', async () => {
      // Call onClose for client-initiated closures (if not already called by server close)
      await callOnClose('client')
      if (connection) {
        controller.unregisterConnection(connectionId)
      }
      resolve()
    })
  })

  // The SSE context object passed to handlers
  const sseContext: SSEContext<Events> = {
    start: <Context = unknown>(
      mode: SSESessionMode,
      startOptions?: SSEStartOptions<Context>,
    ): SSESession<Events, Context> => {
      if (started) {
        throw new Error('SSE streaming already started. Cannot call start() multiple times.')
      }
      if (responseSent) {
        throw new Error('Cannot start streaming after sending a response.')
      }

      started = true
      sessionMode = mode

      // Register callback for when server explicitly closes via reply.sse.close()
      sseReply.sse.onClose(async () => {
        await callOnClose('server')
      })

      // Send headers if not already sent via sendHeaders()
      if (!headersSent) {
        // Tell @fastify/sse to keep the connection open after handler returns
        sseReply.sse.keepAlive()

        // Send headers and flush them to establish the stream
        sseReply.sse.sendHeaders()
        reply.raw.flushHeaders()
        headersSent = true
      }

      // Handle reconnection with Last-Event-ID
      // Create a deferred promise so we can pass it to the connection before starting reconnection
      const lastEventId = request.headers['last-event-id']
      let reconnectionResolve: (() => void) | undefined
      const reconnectionPromise =
        lastEventId && options?.onReconnect
          ? new Promise<void>((resolve) => {
              reconnectionResolve = resolve
            })
          : undefined

      // Create connection with the reconnection promise
      // The send() method will await this promise to ensure event ordering
      connection = createSSESessionInternal(
        connectionId,
        request,
        reply,
        sseReply,
        eventSchemas,
        controller,
        startOptions?.context,
        reconnectionPromise,
      ) as SSESession<Events>

      // Register connection with controller
      controller.registerConnection(connection as unknown as SSESession)

      // Now that connection exists, handle reconnection with a valid SSESession
      if (lastEventId && options?.onReconnect && reconnectionResolve) {
        // Start reconnection asynchronously - connection.send() will wait for it
        ;(async () => {
          try {
            const replayEvents = await options.onReconnect?.(
              connection as unknown as SSESession,
              lastEventId as string,
            )
            if (replayEvents) {
              await sendReplayEvents(sseReply, replayEvents)
            }
          } catch (err) {
            options?.logger?.error(
              { err, lastEventId },
              `Error in ${logPrefix} onReconnect handler`,
            )
          } finally {
            reconnectionResolve?.()
          }
        })()
      }

      // Fire onConnect hook (not awaited per plan)
      fireOnConnect(connection)

      return connection as SSESession<Events, Context>
    },

    respond: (code: number, body: unknown): SSERespondResult => {
      if (started) {
        throw new Error('Cannot send response after streaming has started.')
      }
      responseSent = true
      responseData = { code, body }
      return { _type: 'respond', code, body }
    },

    sendHeaders: (): void => {
      if (headersSent) {
        throw new Error('Headers already sent. Cannot call sendHeaders() multiple times.')
      }
      if (started) {
        throw new Error('Headers already sent via start().')
      }
      if (responseSent) {
        throw new Error('Cannot send headers after sending a response.')
      }
      sseReply.sse.keepAlive()
      sseReply.sse.sendHeaders()
      reply.raw.flushHeaders()
      headersSent = true
    },

    reply,
  }

  return {
    sseContext,
    connectionClosed,
    sseReply,
    getConnection: () => connection,
    getConnectionId: () => (started ? connectionId : undefined),
    isStarted: () => started,
    hasResponse: () => responseSent,
    getResponseData: () => responseData,
    getMode: () => sessionMode,
  }
}

/**
 * Setup an SSE connection with all the boilerplate:
 * - Create connection object with typed event sender
 * - Register with controller
 * - Setup disconnect handler
 * - Initialize SSE reply (keepAlive, sendHeaders, flushHeaders)
 * - Handle reconnection
 * - Call onConnect hook
 *
 * @deprecated Use createSSEContext for new code. This function is kept for backwards compatibility.
 *
 * @returns Connection setup result with connection object and closed promise
 */
export async function setupSSESession<Events extends SSEEventSchemas>(
  controller: SSEControllerLike,
  request: FastifyRequest,
  reply: FastifyReply,
  eventSchemas: Events,
  options: SSELifecycleOptions | undefined,
  logPrefix = 'SSE',
): Promise<SSESessionSetupResult<Events>> {
  // Use the new context-based approach internally
  const result = createSSEContext(controller, request, reply, eventSchemas, options, logPrefix)

  // Auto-start the connection (old behavior - keepAlive by default)
  const connection = result.sseContext.start('keepAlive')

  // Wait for onConnect to complete (old behavior was awaited)
  // Note: In the new API, onConnect is not awaited, but for backwards compat we simulate it
  // by giving it a tick to run
  await new Promise((resolve) => setImmediate(resolve))

  return {
    connectionId: connection.id,
    connection,
    connectionClosed: result.connectionClosed,
    sseReply: result.sseReply,
  }
}

/**
 * Determine response mode from Accept header.
 *
 * Parses the Accept header and determines whether to use JSON or SSE mode.
 * Supports quality values (q=) for content negotiation.
 *
 * @param accept - The Accept header value
 * @param defaultMode - Mode to use when no preference is specified
 * @returns The determined response mode
 */
export function determineMode(
  accept: string | undefined,
  defaultMode: DualModeType = 'json',
): DualModeType {
  if (!accept) return defaultMode

  // Split by comma and parse each media type with quality value
  const mediaTypes = accept
    .split(',')
    .map((part) => {
      const [mediaType, ...params] = part.trim().split(';')
      let quality = 1.0

      for (const param of params) {
        const [key, value] = param.trim().split('=')
        if (key === 'q' && value) {
          quality = Number.parseFloat(value)
        }
      }

      return { mediaType: (mediaType ?? '').trim().toLowerCase(), quality }
    })
    // Filter out rejected types (quality <= 0)
    .filter((entry) => entry.quality > 0)

  // Sort by quality (highest first)
  mediaTypes.sort((a, b) => b.quality - a.quality)

  // Find the first matching type
  for (const { mediaType } of mediaTypes) {
    if (mediaType === 'text/event-stream') {
      return 'sse'
    }
    if (mediaType === 'application/json') {
      return 'json'
    }
  }

  // If */* is present with highest priority, use default
  if (mediaTypes.some((m) => m.mediaType === '*/*')) {
    return defaultMode
  }

  return defaultMode
}

/**
 * Result of sync format determination.
 */
export type SyncFormatResult = { mode: 'sse' } | { mode: 'sync'; contentType: string }

/**
 * Determine sync format from Accept header for content negotiation.
 *
 * Parses the Accept header and determines which format to use.
 * Supports quality values (q=) for content negotiation and subtype wildcards
 * (e.g., "application/*", "text/*").
 *
 * Matching priority:
 * 1. text/event-stream (SSE mode)
 * 2. Exact matches against supportedFormats
 * 3. Subtype wildcards (e.g., "text/*" matches first "text/..." in supportedFormats)
 * 4. Full wildcard (*\/*) uses fallback format
 * 5. Fallback to defaultFormat or first supported format
 *
 * @param accept - The Accept header value
 * @param supportedFormats - Array of Content-Types that the route supports
 * @param defaultFormat - Format to use when no preference is specified (default: first supported format)
 * @returns The determined format or 'sse' mode indicator
 */
export function determineSyncFormat(
  accept: string | undefined,
  supportedFormats: string[],
  defaultFormat?: string,
): SyncFormatResult {
  const fallbackFormat = defaultFormat ?? supportedFormats[0] ?? 'application/json'

  if (!accept) {
    return { mode: 'sync', contentType: fallbackFormat }
  }

  // Split by comma and parse each media type with quality value
  const mediaTypes = accept
    .split(',')
    .map((part) => {
      const [mediaType, ...params] = part.trim().split(';')
      let quality = 1.0

      for (const param of params) {
        const [key, value] = param.trim().split('=')
        if (key === 'q' && value) {
          quality = Number.parseFloat(value)
        }
      }

      return { mediaType: (mediaType ?? '').trim().toLowerCase(), quality }
    })
    // Filter out rejected types (quality <= 0)
    .filter((entry) => entry.quality > 0)

  // Sort by quality (highest first)
  mediaTypes.sort((a, b) => b.quality - a.quality)

  // Find the first matching type
  for (const { mediaType } of mediaTypes) {
    // SSE takes priority if requested
    if (mediaType === 'text/event-stream') {
      return { mode: 'sse' }
    }
    // Check exact match against supported formats
    if (supportedFormats.includes(mediaType)) {
      return { mode: 'sync', contentType: mediaType }
    }
    // Check subtype wildcard (e.g., "application/*", "text/*")
    if (mediaType.endsWith('/*')) {
      const mainType = mediaType.slice(0, -2) // Extract "application" from "application/*"
      const matchedFormat = supportedFormats.find((format) => format.startsWith(`${mainType}/`))
      if (matchedFormat) {
        return { mode: 'sync', contentType: matchedFormat }
      }
    }
  }

  // If */* is present, use default format
  if (mediaTypes.some((m) => m.mediaType === '*/*')) {
    return { mode: 'sync', contentType: fallbackFormat }
  }

  // Default to first supported format
  return { mode: 'sync', contentType: fallbackFormat }
}
