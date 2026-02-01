import { randomUUID } from 'node:crypto'
import type { SSEReplyInterface } from '@fastify/sse'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { z } from 'zod'
import type { DualModeType } from '../dualmode/dualModeTypes.ts'
import type { SSEEventSchemas, SSEEventSender, SSELogger, SSEMessage } from '../sse/sseTypes.ts'
import type { SSEConnection, SSEStreamMessage } from './fastifyRouteTypes.ts'

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
  registerConnection(connection: SSEConnection): void
  unregisterConnection(connectionId: string): void
}

/**
 * Options for SSE connection lifecycle hooks.
 */
export type SSELifecycleOptions<TConnection = SSEConnection> = {
  onConnect?: (connection: TConnection) => void | Promise<void>
  /**
   * Called when the SSE connection is explicitly closed by the server via reply.sse.close().
   * This is different from onDisconnect which fires when the underlying socket closes
   * (client disconnect, network failure, etc.).
   *
   * Use onClose for cleanup when you explicitly close a connection.
   * Use onDisconnect for cleanup when the client disconnects.
   */
  onClose?: (connection: TConnection) => void | Promise<void>
  onDisconnect?: (connection: TConnection) => void | Promise<void>
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
  connection: SSEConnection,
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
export type SSEConnectionSetupResult<Events extends SSEEventSchemas = SSEEventSchemas> = {
  connectionId: string
  connection: SSEConnection<Events>
  connectionClosed: Promise<void>
  sseReply: SSEReply
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
 * @returns Connection setup result with connection object and closed promise
 */
export async function setupSSEConnection<Events extends SSEEventSchemas>(
  controller: SSEControllerLike,
  request: FastifyRequest,
  reply: FastifyReply,
  eventSchemas: Events,
  options: SSELifecycleOptions | undefined,
  logPrefix = 'SSE',
): Promise<SSEConnectionSetupResult<Events>> {
  const connectionId = randomUUID()

  // Create type-safe event sender for the handler
  const send: SSEEventSender<Events> = (eventName, data, sendOptions) => {
    return controller._sendEventRaw(connectionId, {
      event: eventName,
      data,
      id: sendOptions?.id,
      retry: sendOptions?.retry,
    })
  }

  const sseReply = reply as SSEReply

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

  // Create connection wrapper with event schemas for validation and typed send
  const connection: SSEConnection<Events> = {
    id: connectionId,
    request,
    reply,
    context: {},
    connectedAt: new Date(),
    send,
    isConnected: () => sseReply.sse.isConnected,
    getStream: () => sseReply.sse.stream(),
    sendStream,
    eventSchemas,
  }

  // Create a promise that will resolve when the client disconnects
  // Cast connection for lifecycle callbacks - they don't need type-safe event schemas
  const connectionClosed = new Promise<void>((resolve) => {
    request.socket.on('close', async () => {
      try {
        await options?.onDisconnect?.(connection as unknown as SSEConnection)
      } catch (err) {
        options?.logger?.error({ err }, `Error in ${logPrefix} onDisconnect handler`)
      } finally {
        controller.unregisterConnection(connectionId)
        resolve()
      }
    })
  })

  // Register connection with controller
  controller.registerConnection(connection as unknown as SSEConnection)

  // Tell @fastify/sse to keep the connection open after handler returns
  sseReply.sse.keepAlive()

  // Register onClose callback if provided (fires when server explicitly closes connection)
  if (options?.onClose) {
    sseReply.sse.onClose(async () => {
      try {
        await options.onClose?.(connection as unknown as SSEConnection)
      } catch (err) {
        options?.logger?.error({ err }, `Error in ${logPrefix} onClose handler`)
      }
    })
  }

  // Send headers and flush them to establish the stream
  sseReply.sse.sendHeaders()
  reply.raw.flushHeaders()

  // Handle reconnection with Last-Event-ID
  const lastEventId = request.headers['last-event-id']
  if (lastEventId) {
    await handleReconnection(
      sseReply,
      connection as unknown as SSEConnection,
      lastEventId as string,
      options,
      logPrefix,
    )
  }

  // Notify connection established
  try {
    await options?.onConnect?.(connection as unknown as SSEConnection)
  } catch (err) {
    options?.logger?.error({ err }, `Error in ${logPrefix} onConnect handler`)
  }

  return {
    connectionId,
    connection,
    connectionClosed,
    sseReply,
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
 * Determine sync format from Accept header for multi-format routes.
 *
 * Parses the Accept header and determines which format handler to use.
 * Supports quality values (q=) for content negotiation.
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
    // Check against supported formats
    if (supportedFormats.includes(mediaType)) {
      return { mode: 'sync', contentType: mediaType }
    }
  }

  // If */* is present, use default format
  if (mediaTypes.some((m) => m.mediaType === '*/*')) {
    return { mode: 'sync', contentType: fallbackFormat }
  }

  // Default to first supported format
  return { mode: 'sync', contentType: fallbackFormat }
}
