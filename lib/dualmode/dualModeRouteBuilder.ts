import { randomUUID } from 'node:crypto'
import type { SSEReplyInterface } from '@fastify/sse'
import { InternalError } from '@lokalise/node-core'
import type { FastifyReply, RouteOptions } from 'fastify'
import type { z } from 'zod'
import type { SSEConnection, SSEEventSender, SSEMessage } from '../sse/sseTypes.ts'
import type { AbstractDualModeController } from './AbstractDualModeController.ts'
import type { AnyDualModeRouteDefinition, PathResolver } from './dualModeContracts.ts'
import type {
  DualModeHandlerConfig,
  DualModeType,
} from './dualModeTypes.ts'

/**
 * FastifyReply extended with SSE capabilities from @fastify/sse.
 */
type SSEReply = FastifyReply & { sse: SSEReplyInterface }

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
  pathResolver: PathResolver<Params>,
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
  const mediaTypes = accept.split(',').map((part) => {
    const [mediaType, ...params] = part.trim().split(';')
    let quality = 1.0

    for (const param of params) {
      const [key, value] = param.trim().split('=')
      if (key === 'q' && value) {
        quality = Number.parseFloat(value)
      }
    }

    return { mediaType: mediaType!.trim().toLowerCase(), quality }
  })

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
 * Check if a value is an Error-like object (cross-realm safe).
 * Uses duck typing instead of instanceof for reliability across realms.
 */
function isErrorLike(err: unknown): err is { message: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'message' in err &&
    typeof (err as { message: unknown }).message === 'string'
  )
}

/**
 * Send error event to client and close connection gracefully.
 */
async function handleSSEHandlerError(
  sseReply: SSEReply,
  controller: AbstractDualModeController<Record<string, AnyDualModeRouteDefinition>>,
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
 * Send replay events from either sync or async iterables.
 */
async function sendReplayEvents(
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
async function handleReconnection(
  sseReply: SSEReply,
  connection: SSEConnection,
  lastEventId: string,
  options: DualModeHandlerConfig<AnyDualModeRouteDefinition>['options'],
): Promise<void> {
  if (!options?.onReconnect) return

  try {
    const replayEvents = await options.onReconnect(connection, lastEventId)
    if (replayEvents) {
      await sendReplayEvents(sseReply, replayEvents)
    }
  } catch (err) {
    options?.logger?.error({ err, lastEventId }, 'Error in dual-mode SSE onReconnect handler')
  }
}

/**
 * Build a Fastify route configuration for a dual-mode endpoint.
 *
 * This function creates a route that handles both JSON and SSE responses
 * based on the Accept header, integrating with @fastify/sse for SSE mode
 * and the AbstractDualModeController for connection management.
 *
 * @param controller - The dual-mode controller instance
 * @param config - The dual-mode handler configuration
 * @returns Fastify route options
 */
export function buildFastifyDualModeRoute<Contract extends AnyDualModeRouteDefinition>(
  controller: AbstractDualModeController<Record<string, AnyDualModeRouteDefinition>>,
  config: DualModeHandlerConfig<Contract>,
): RouteOptions {
  const { contract, handlers, options } = config
  const defaultMode = options?.defaultMode ?? 'json'

  // Extract Fastify path template from pathResolver
  const url = extractPathTemplate(
    contract.pathResolver,
    contract.params as z.ZodObject<z.ZodRawShape>,
  )

  const routeOptions: RouteOptions = {
    method: contract.method,
    url,
    sse: true, // Enable SSE support (required for SSE mode)
    schema: {
      params: contract.params,
      querystring: contract.query,
      headers: contract.requestHeaders,
      ...(contract.body && { body: contract.body }),
      // Note: response schema for JSON mode could be added here
    },
    handler: async (request, reply) => {
      const mode = determineMode(request.headers.accept, defaultMode)

      if (mode === 'json') {
        // JSON mode - call json handler and return response
        const response = await handlers.json({
          mode: 'json',
          request: request as Parameters<typeof handlers.json>[0]['request'],
          reply,
        })

        // Validate response against schema if available
        if (contract.jsonResponse) {
          const result = contract.jsonResponse.safeParse(response)
          if (!result.success) {
            throw new InternalError({
              message: `JSON response validation failed: ${result.error.message}`,
              errorCode: 'RESPONSE_VALIDATION_FAILED',
            })
          }
        }

        // Explicitly set content-type to override SSE default (from sse: true option)
        return reply.type('application/json').send(response)
      }

      // SSE mode - setup connection and stream events
      const connectionId = randomUUID()

      // Create type-safe event sender for the handler
      const send: SSEEventSender<Contract['events']> = (eventName, data, sendOptions) => {
        return controller._sendEventRaw(connectionId, {
          event: eventName,
          data,
          id: sendOptions?.id,
          retry: sendOptions?.retry,
        })
      }

      // Create connection wrapper with event schemas for validation and typed send
      const connection = {
        id: connectionId,
        request,
        reply,
        context: {},
        connectedAt: new Date(),
        send,
        eventSchemas: contract.events,
      }

      // Create a promise that will resolve when the client disconnects
      const connectionClosed = new Promise<void>((resolve) => {
        request.socket.on('close', async () => {
          try {
            await options?.onDisconnect?.(connection)
          } catch (err) {
            options?.logger?.error({ err }, 'Error in dual-mode SSE onDisconnect handler')
          } finally {
            controller.unregisterConnection(connectionId)
            resolve()
          }
        })
      })

      // Register connection with controller
      controller.registerConnection(connection)

      // Tell @fastify/sse to keep the connection open after handler returns
      const sseReply = reply as SSEReply
      sseReply.sse.keepAlive()

      // Send headers and flush them to establish the stream
      sseReply.sse.sendHeaders()
      reply.raw.flushHeaders()

      // Handle reconnection with Last-Event-ID
      const lastEventId = request.headers['last-event-id']
      if (lastEventId) {
        await handleReconnection(sseReply, connection, lastEventId as string, options)
      }

      // Notify connection established
      try {
        await options?.onConnect?.(connection)
      } catch (err) {
        options?.logger?.error({ err }, 'Error in dual-mode SSE onConnect handler')
      }

      // Call user handler with SSE context
      try {
        await handlers.sse({
          mode: 'sse',
          connection: connection as Parameters<typeof handlers.sse>[0]['connection'],
          request: request as Parameters<typeof handlers.sse>[0]['request'],
        })
      } catch (err) {
        await handleSSEHandlerError(sseReply, controller, connectionId, err)
        throw err
      }

      // Block the handler until the connection closes
      await connectionClosed
    },
  }

  // Add preHandler hooks for authentication
  if (options?.preHandler) {
    routeOptions.preHandler = options.preHandler
  }

  return routeOptions
}
