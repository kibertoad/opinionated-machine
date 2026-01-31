import type { RouteOptions } from 'fastify'
import type { z } from 'zod'
import type { AbstractSSEController } from './AbstractSSEController.ts'
import type { AnySSEContractDefinition } from './sseContracts.ts'
import { extractPathTemplate, handleSSEError, setupSSEConnection } from './sseRouteUtils.ts'
import type { SSEHandlerConfig } from './sseTypes.ts'

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
export function buildFastifySSERoute<Contract extends AnySSEContractDefinition>(
  controller: AbstractSSEController<Record<string, AnySSEContractDefinition>>,
  config: SSEHandlerConfig<Contract>,
): RouteOptions {
  const { contract, handler, options } = config

  const url = extractPathTemplate(
    contract.pathResolver,
    contract.params as z.ZodObject<z.ZodRawShape>,
  )

  const routeOptions: RouteOptions = {
    method: contract.method,
    url,
    sse: true,
    schema: {
      params: contract.params,
      querystring: contract.query,
      headers: contract.requestHeaders,
      ...(contract.body && { body: contract.body }),
    },
    handler: async (request, reply) => {
      // Setup SSE connection with all boilerplate
      const { connectionId, connection, connectionClosed, sseReply } = await setupSSEConnection(
        controller,
        request,
        reply,
        contract.events,
        options,
        'SSE',
      )

      // Call user handler with connection (which has typed send method)
      // Errors (including validation errors) are caught, sent as error events, and re-thrown
      // so the app's error handler can process them (for logging, monitoring, etc.)
      try {
        // biome-ignore lint/suspicious/noExplicitAny: Handler types are validated by SSEHandlerConfig
        await handler(request as any, connection as any)
      } catch (err) {
        await handleSSEError(sseReply, controller, connectionId, err)

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
