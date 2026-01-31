import { InternalError } from '@lokalise/node-core'
import type { FastifyReply, RouteOptions } from 'fastify'
import type { z } from 'zod'
import { ZodObject } from 'zod'
import {
  extractPathTemplate,
  handleSSEError,
  setupSSEConnection,
} from '../sse/fastifySSERouteUtils.ts'
import type { AbstractDualModeController } from './AbstractDualModeController.ts'
import type { AnyDualModeContractDefinition } from './dualModeContracts.ts'
import type { DualModeType } from './dualModeTypes.ts'
import type { FastifyDualModeHandlerConfig } from './fastifyDualModeTypes.ts'

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
 * Validate response body against the syncResponse schema.
 */
function validateResponseBody(contract: AnyDualModeContractDefinition, response: unknown): void {
  if (!contract.syncResponse) return

  const result = contract.syncResponse.safeParse(response)
  if (!result.success) {
    throw new InternalError({
      message: `JSON response validation failed: ${result.error.message}`,
      errorCode: 'RESPONSE_VALIDATION_FAILED',
    })
  }
}

/**
 * Validate response headers against the responseHeaders schema.
 */
function validateResponseHeaders(
  responseHeadersSchema: z.ZodTypeAny | undefined,
  reply: FastifyReply,
): void {
  if (!responseHeadersSchema) return
  if (!('shape' in responseHeadersSchema)) return

  const schemaKeys = Object.keys(
    (responseHeadersSchema as { shape: Record<string, unknown> }).shape,
  )
  const headersToValidate: Record<string, unknown> = {}
  for (const key of schemaKeys) {
    const headerValue = reply.getHeader(key)
    if (headerValue !== undefined) {
      headersToValidate[key] = headerValue
    }
  }

  const result = responseHeadersSchema.safeParse(headersToValidate)
  if (!result.success) {
    throw new InternalError({
      message: `Response headers validation failed: ${result.error.message}`,
      errorCode: 'RESPONSE_HEADERS_VALIDATION_FAILED',
    })
  }
}

/**
 * Handle JSON mode request.
 */
async function handleJsonMode<Contract extends AnyDualModeContractDefinition>(
  contract: Contract,
  handlers: FastifyDualModeHandlerConfig<Contract>['handlers'],
  // biome-ignore lint/suspicious/noExplicitAny: Request types are validated by Fastify schema
  request: any,
  reply: FastifyReply,
) {
  const response = await handlers.json({
    mode: 'json',
    request,
    reply,
  })

  validateResponseBody(contract, response)

  // Explicitly set content-type to override SSE default (from sse: true option)
  reply.type('application/json')

  validateResponseHeaders(contract.responseHeaders, reply)

  return reply.send(response)
}

/**
 * Handle SSE mode request.
 */
async function handleSSEMode<Contract extends AnyDualModeContractDefinition>(
  controller: AbstractDualModeController<Record<string, AnyDualModeContractDefinition>>,
  contract: Contract,
  handlers: FastifyDualModeHandlerConfig<Contract>['handlers'],
  // biome-ignore lint/suspicious/noExplicitAny: Request types are validated by Fastify schema
  request: any,
  reply: FastifyReply,
  options: FastifyDualModeHandlerConfig<Contract>['options'],
) {
  const { connectionId, connection, connectionClosed, sseReply } = await setupSSEConnection(
    controller,
    request,
    reply,
    contract.events,
    options,
    'dual-mode SSE',
  )

  try {
    await handlers.sse({
      mode: 'sse',
      connection: connection as Parameters<typeof handlers.sse>[0]['connection'],
      request,
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
export function buildFastifyDualModeRoute<Contract extends AnyDualModeContractDefinition>(
  controller: AbstractDualModeController<Record<string, AnyDualModeContractDefinition>>,
  config: FastifyDualModeHandlerConfig<Contract>,
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
        return await handleJsonMode(contract, handlers, request, reply)
      }

      return await handleSSEMode(controller, contract, handlers, request, reply, options)
    },
  }

  // Add preHandler hooks for authentication
  if (options?.preHandler) {
    routeOptions.preHandler = options.preHandler
  }

  return routeOptions
}
