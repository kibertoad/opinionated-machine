import { InternalError } from '@lokalise/node-core'
import type { RouteOptions } from 'fastify'
import { ZodObject } from 'zod'
import { extractPathTemplate, handleSSEError, setupSSEConnection } from '../sse/sseRouteUtils.ts'
import type { AbstractDualModeController } from './AbstractDualModeController.ts'
import type { AnyDualModeRouteDefinition } from './dualModeContracts.ts'
import type { DualModeHandlerConfig, DualModeType } from './dualModeTypes.ts'

// Re-export for convenience
export { extractPathTemplate }

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
  // Runtime guard: extractPathTemplate requires a ZodObject to access .shape for parameter names
  if (!(contract.params instanceof ZodObject)) {
    throw new InternalError({
      message: `Route params schema must be a ZodObject for path template extraction, got ${contract.params.constructor.name}`,
      errorCode: 'INVALID_PARAMS_SCHEMA',
    })
  }
  const url = extractPathTemplate(contract.pathResolver, contract.params)

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

      // SSE mode - setup connection and stream events using shared utility
      const { connectionId, connection, connectionClosed, sseReply } = await setupSSEConnection(
        controller,
        request,
        reply,
        contract.events,
        options,
        'dual-mode SSE',
      )

      // Call user handler with SSE context
      try {
        await handlers.sse({
          mode: 'sse',
          connection: connection as Parameters<typeof handlers.sse>[0]['connection'],
          request: request as Parameters<typeof handlers.sse>[0]['request'],
        })
      } catch (err) {
        await handleSSEError(sseReply, controller, connectionId, err)
        // Re-throw the error intentionally to let Fastify's error handler and onError hooks
        // run for logging/monitoring purposes. Although headers are already sent at this point
        // (so the HTTP status code cannot be changed), propagating the error ensures that
        // application-level error tracking, metrics, and logging infrastructure can observe
        // and record the failure.
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
