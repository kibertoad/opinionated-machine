import { randomUUID } from 'node:crypto'
import type { SSEReplyInterface } from '@fastify/sse'
import type { FastifyReply, RouteOptions } from 'fastify'
import type { AbstractSSEController } from './AbstractSSEController.ts'
import type { AnySSERouteDefinition } from './sseContracts.ts'
import type { SSEConnection, SSEEventSender, SSEHandlerConfig, SSEMessage } from './sseTypes.ts'

/**
 * FastifyReply extended with SSE capabilities from @fastify/sse.
 */
type SSEReply = FastifyReply & { sse: SSEReplyInterface }

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
  options: SSEHandlerConfig<AnySSERouteDefinition>['options'],
): Promise<void> {
  if (!options?.onReconnect) return

  try {
    const replayEvents = await options.onReconnect(connection, lastEventId)
    if (replayEvents) {
      await sendReplayEvents(sseReply, replayEvents)
    }
  } catch (err) {
    options?.logger?.error({ err, lastEventId }, 'Error in SSE onReconnect handler')
  }
}

/**
 * Send error event to client and close connection gracefully.
 */
async function handleHandlerError(
  sseReply: SSEReply,
  controller: AbstractSSEController<Record<string, AnySSERouteDefinition>>,
  connectionId: string,
  err: unknown,
): Promise<void> {
  // Send error event to client (bypasses validation since this is framework-level)
  try {
    await sseReply.sse.send({
      event: 'error',
      data: { message: err instanceof Error ? err.message : 'Internal server error' },
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
 * Build a Fastify route configuration for an SSE endpoint.
 *
 * This function creates a route that integrates with @fastify/sse
 * and the AbstractSSEController connection management.
 *
 * @param controller - The SSE controller instance
 * @param config - The SSE handler configuration
 * @returns Fastify route options
 */
export function buildFastifySSERoute<Contract extends AnySSERouteDefinition>(
  controller: AbstractSSEController<Record<string, AnySSERouteDefinition>>,
  config: SSEHandlerConfig<Contract>,
): RouteOptions {
  const { contract, handler, options } = config

  const routeOptions: RouteOptions = {
    method: contract.method,
    url: contract.path,
    sse: true,
    schema: {
      params: contract.params,
      querystring: contract.query,
      headers: contract.requestHeaders,
      ...(contract.body && { body: contract.body }),
    },
    handler: async (request, reply) => {
      const connectionId = randomUUID()

      // Create connection wrapper with event schemas for validation
      const connection: SSEConnection = {
        id: connectionId,
        request,
        reply,
        context: {},
        connectedAt: new Date(),
        eventSchemas: contract.events,
      }

      // Create a promise that will resolve when the client disconnects
      // Using request.socket.on('close') as per @fastify/sse documentation
      const connectionClosed = new Promise<void>((resolve) => {
        request.socket.on('close', async () => {
          try {
            await options?.onDisconnect?.(connection)
          } catch (err) {
            // Log the error but don't let it prevent cleanup
            options?.logger?.error({ err }, 'Error in SSE onDisconnect handler')
          } finally {
            // Always unregister the connection and resolve, even if onDisconnect throws
            controller.unregisterConnection(connectionId)
            resolve()
          }
        })
      })

      // Register connection with controller
      controller.registerConnection(connection)

      // Tell @fastify/sse to keep the connection open after handler returns
      // Without this, the plugin closes the connection immediately
      const sseReply = reply as SSEReply
      sseReply.sse.keepAlive()

      // Send headers and flush them to establish the stream
      // flushHeaders() ensures headers are sent immediately without waiting for body data
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
        options?.logger?.error({ err }, 'Error in SSE onConnect handler')
      }

      // Create type-safe event sender for the handler
      // This provides compile-time checking that event names and data match the contract
      const send: SSEEventSender<Contract['events']> = (eventName, data, sendOptions) => {
        return controller.sendEventInternal(connectionId, {
          event: eventName,
          data,
          id: sendOptions?.id,
          retry: sendOptions?.retry,
        })
      }

      // Call user handler with typed event sender
      // Errors (including validation errors) are caught, sent as error events, and re-thrown
      // so the app's error handler can process them (for logging, monitoring, etc.)
      try {
        // biome-ignore lint/suspicious/noExplicitAny: Handler types are validated by SSEHandlerConfig
        await handler(request as any, connection, send)
      } catch (err) {
        await handleHandlerError(sseReply, controller, connectionId, err)

        // Re-throw to let Fastify's error handler process it (for logging, onError hooks, etc.)
        // Note: Since headers are already sent, Fastify can't change the response status,
        // but error hooks will still fire for monitoring/logging purposes
        throw err
      }

      // Block the handler until the connection closes
      // This prevents Fastify from ending the response prematurely
      await connectionClosed
    },
  }

  // Add preHandler hooks for authentication
  if (options?.preHandler) {
    routeOptions.preHandler = options.preHandler
  }

  return routeOptions
}

/**
 * Options for registering SSE routes globally.
 */
export type RegisterSSERoutesOptions = {
  /**
   * Heartbeat interval in milliseconds.
   * @default 30000
   */
  heartbeatInterval?: number
  /**
   * Custom serializer for SSE message data.
   * @default JSON.stringify
   */
  serializer?: (data: unknown) => string
  /**
   * Global preHandler hooks applied to all SSE routes.
   * Use for authentication that should apply to all SSE endpoints.
   */
  preHandler?: RouteOptions['preHandler']
  /**
   * Rate limit configuration (requires @fastify/rate-limit to be registered).
   * If @fastify/rate-limit is not registered, this config is ignored.
   */
  rateLimit?: {
    /** Maximum number of connections */
    max: number
    /** Time window for rate limiting */
    timeWindow: string | number
    /** Custom key generator (e.g., for per-user limits) */
    keyGenerator?: (request: unknown) => string
  }
}
