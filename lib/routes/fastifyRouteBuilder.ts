import { InternalError } from '@lokalise/node-core'
import type { FastifyReply, RouteOptions } from 'fastify'
import type { z } from 'zod'
import { ZodObject } from 'zod'
import type { AbstractDualModeController } from '../dualmode/AbstractDualModeController.ts'
import type { AnyDualModeContractDefinition } from '../dualmode/dualModeContracts.ts'
import type { AbstractSSEController } from '../sse/AbstractSSEController.ts'
import type { AnySSEContractDefinition } from '../sse/sseContracts.ts'
import type { FastifyDualModeHandlerConfig, FastifySSEHandlerConfig } from './fastifyRouteTypes.ts'
import {
  determineMode,
  extractPathTemplate,
  handleSSEError,
  setupSSEConnection,
} from './fastifyRouteUtils.ts'

// Re-export for convenience
export { extractPathTemplate }

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
  const response = await handlers.json(request, reply)

  validateResponseBody(contract, response)

  // Explicitly set content-type to override SSE default (from sse: true option)
  reply.type('application/json')

  validateResponseHeaders(contract.responseHeaders, reply)

  return reply.send(response)
}

/**
 * Handle SSE mode request for dual-mode routes.
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
    // biome-ignore lint/suspicious/noExplicitAny: Connection types are validated by FastifyDualModeHandlerConfig
    await handlers.sse(request, connection as any)
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
function buildDualModeRouteInternal<Contract extends AnyDualModeContractDefinition>(
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
function buildSSERouteInternal<Contract extends AnySSEContractDefinition>(
  controller: AbstractSSEController<Record<string, AnySSEContractDefinition>>,
  config: FastifySSEHandlerConfig<Contract>,
): RouteOptions {
  const { contract, handlers, options } = config

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

      // Call user handler with flat (request, connection) signature
      // Errors (including validation errors) are caught, sent as error events, and re-thrown
      // so the app's error handler can process them (for logging, monitoring, etc.)
      try {
        // biome-ignore lint/suspicious/noExplicitAny: Request and connection types are validated by FastifySSEHandlerConfig
        await handlers.sse(request as any, connection as any)
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

// ============================================================================
// Unified Route Builder with Overloads
// ============================================================================

/**
 * Build a Fastify route configuration for a dual-mode endpoint.
 *
 * This overload handles dual-mode contracts (endpoints that support both JSON and SSE responses).
 * The response mode is determined by the Accept header.
 *
 * @param controller - The dual-mode controller instance
 * @param config - The dual-mode handler configuration
 * @returns Fastify route options
 */
export function buildFastifyRoute<Contract extends AnyDualModeContractDefinition>(
  controller: AbstractDualModeController<Record<string, AnyDualModeContractDefinition>>,
  config: FastifyDualModeHandlerConfig<Contract>,
): RouteOptions

/**
 * Build a Fastify route configuration for an SSE endpoint.
 *
 * This overload handles SSE-only contracts (endpoints that only stream SSE responses).
 * Integrates with @fastify/sse and the AbstractSSEController for connection management.
 *
 * @param controller - The SSE controller instance
 * @param config - The SSE handler configuration
 * @returns Fastify route options
 */
export function buildFastifyRoute<Contract extends AnySSEContractDefinition>(
  controller: AbstractSSEController<Record<string, AnySSEContractDefinition>>,
  config: FastifySSEHandlerConfig<Contract>,
): RouteOptions

/**
 * Build a Fastify route configuration for SSE or dual-mode endpoints.
 *
 * This unified function creates routes that integrate with @fastify/sse. The contract type
 * determines the behavior:
 *
 * - **SSE contracts** (no `syncResponse`): Creates SSE-only routes that stream events
 * - **Dual-mode contracts** (has `syncResponse`): Creates routes that branch on Accept header
 *   - `Accept: application/json` → JSON response
 *   - `Accept: text/event-stream` → SSE streaming
 *
 * @example
 * ```typescript
 * // SSE-only route
 * const sseRoute = buildFastifyRoute(sseController, {
 *   contract: notificationsContract,
 *   handler: async (request, connection) => {
 *     await connection.send('notification', { message: 'Hello!' })
 *   },
 * })
 *
 * // Dual-mode route
 * const dualModeRoute = buildFastifyRoute(dualModeController, {
 *   contract: chatCompletionContract,
 *   handlers: {
 *     json: async (ctx) => ({ reply: 'Hello', usage: { tokens: 1 } }),
 *     sse: async (ctx) => {
 *       await ctx.connection.send('chunk', { delta: 'Hello' })
 *       await ctx.connection.send('done', { usage: { total: 1 } })
 *     },
 *   },
 * })
 *
 * // Register with Fastify
 * app.route(sseRoute)
 * app.route(dualModeRoute)
 * ```
 */
export function buildFastifyRoute(
  controller:
    | AbstractDualModeController<Record<string, AnyDualModeContractDefinition>>
    | AbstractSSEController<Record<string, AnySSEContractDefinition>>,
  config:
    | FastifyDualModeHandlerConfig<AnyDualModeContractDefinition>
    | FastifySSEHandlerConfig<AnySSEContractDefinition>,
): RouteOptions {
  // Discriminate by checking for dual-mode handlers (has both 'json' and 'sse')
  // SSE-only handlers have only 'sse'
  if ('handlers' in config && 'json' in config.handlers) {
    // Dual-mode config has handlers with both json and sse
    return buildDualModeRouteInternal(
      controller as AbstractDualModeController<Record<string, AnyDualModeContractDefinition>>,
      config as FastifyDualModeHandlerConfig<AnyDualModeContractDefinition>,
    )
  }

  // SSE-only config has handlers with just sse
  return buildSSERouteInternal(
    controller as AbstractSSEController<Record<string, AnySSEContractDefinition>>,
    config as FastifySSEHandlerConfig<AnySSEContractDefinition>,
  )
}
