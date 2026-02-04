import { InternalError } from '@lokalise/node-core'
import type { FastifyReply, RouteOptions } from 'fastify'
import type { z } from 'zod'
import { ZodObject } from 'zod'
import type { AbstractDualModeController } from '../dualmode/AbstractDualModeController.ts'
import type { AnyDualModeContractDefinition } from '../dualmode/dualModeContracts.ts'
import type { AbstractSSEController } from '../sse/AbstractSSEController.ts'
import type { AnySSEContractDefinition } from '../sse/sseContracts.ts'
import type {
  DualModeRouteHandler,
  FastifyDualModeHandlerConfig,
  FastifySSEHandlerConfig,
  FastifySSERouteOptions,
  SSEHandlerResult,
  SSERouteHandler,
} from './fastifyRouteTypes.ts'
import {
  createSSEContext,
  determineMode,
  extractPathTemplate,
  handleSSEError,
  isErrorLike,
} from './fastifyRouteUtils.ts'

// Re-export for convenience
export { extractPathTemplate }

/**
 * Build the SSE config object for route options.
 * Returns true for basic SSE support, or an object with custom serializer/heartbeat.
 */
function buildSSEConfig(
  options: FastifySSERouteOptions | undefined,
): true | { serializer?: (data: unknown) => string; heartbeatInterval?: number } {
  if (!options?.serializer && options?.heartbeatInterval === undefined) {
    return true
  }

  const sseConfig: { serializer?: (data: unknown) => string; heartbeatInterval?: number } = {}

  if (options.serializer) {
    sseConfig.serializer = options.serializer
  }

  if (options.heartbeatInterval !== undefined) {
    sseConfig.heartbeatInterval = options.heartbeatInterval
  }

  return sseConfig
}

/**
 * Validate response body against the syncResponseBody schema.
 */
function validateResponseBody(contract: AnyDualModeContractDefinition, response: unknown): void {
  const schema = contract.syncResponseBody
  if (!schema) return

  const result = schema.safeParse(response)
  if (!result.success) {
    throw new InternalError({
      message: `Response validation failed for application/json: ${result.error.message}`,
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

  // Build object with all schema keys (including missing ones) so Zod can validate required fields
  const schemaKeys = Object.keys(
    (responseHeadersSchema as { shape: Record<string, unknown> }).shape,
  )
  const headersToValidate: Record<string, unknown> = {}
  for (const key of schemaKeys) {
    headersToValidate[key] = reply.getHeader(key)
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
 * Handle sync mode request.
 */
async function handleSyncMode<Contract extends AnyDualModeContractDefinition>(
  contract: Contract,
  handlers: FastifyDualModeHandlerConfig<Contract>['handlers'],
  // biome-ignore lint/suspicious/noExplicitAny: Request types are validated by Fastify schema
  request: any,
  reply: FastifyReply,
) {
  // biome-ignore lint/suspicious/noExplicitAny: Handler type depends on contract
  const response = await (handlers as any).sync(request, reply)

  validateResponseBody(contract, response)

  // Explicitly set content-type to override SSE default (from sse: true option)
  reply.type('application/json')

  validateResponseHeaders(contract.responseHeaders, reply)

  return reply.send(response)
}

/**
 * Process SSE handler result and manage connection lifecycle.
 */
async function processSSEHandlerResult(
  result: SSEHandlerResult,
  controller:
    | AbstractDualModeController<Record<string, AnyDualModeContractDefinition>>
    | AbstractSSEController<Record<string, AnySSEContractDefinition>>,
  connectionId: string | undefined,
  connectionClosed: Promise<void>,
  reply: FastifyReply,
  mode: 'autoClose' | 'keepAlive' | undefined,
): Promise<void> {
  // Check if handler returned an early response (before streaming started)
  if (result && result._type === 'respond') {
    // Send HTTP response (early return before streaming started).
    // Clean up SSE-specific headers that @fastify/sse sets early in the lifecycle.
    // Not strictly necessary, but avoids confusing headers on JSON responses.
    reply.removeHeader('cache-control')
    reply.removeHeader('x-accel-buffering')
    // Critical: override content-type from text/event-stream to application/json,
    // otherwise the zod serializer compiler won't serialize the body correctly.
    reply.type('application/json').code(result.code).send(result.body)
    return
  }

  // Streaming was started, mode determines what happens next
  if (mode === 'autoClose') {
    // Request-response streaming: close session after handler completes
    if (connectionId) {
      controller.closeConnection(connectionId)
    }
  } else if (mode === 'keepAlive') {
    // Long-lived session: wait for client to disconnect
    await connectionClosed
  }
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
  const contextResult = createSSEContext(
    controller,
    request,
    reply,
    contract.sseEvents,
    options,
    'dual-mode SSE',
  )

  try {
    // biome-ignore lint/suspicious/noExplicitAny: SSEContext types are validated by FastifyDualModeHandlerConfig
    const result = await handlers.sse(request, contextResult.sseContext as any)

    // Check for forgotten start() detection
    // Handler must either start streaming OR send a response
    // Note: With autoClose mode, handlers return void after start(), which is valid
    if (!contextResult.isStarted() && (!result || result._type !== 'respond')) {
      throw new Error(
        'SSE handler must either send a response (sse.respond()) ' +
          'or start streaming (sse.start()). Handler returned without doing either.',
      )
    }

    // Process the result
    await processSSEHandlerResult(
      result,
      controller,
      contextResult.getConnectionId(),
      contextResult.connectionClosed,
      reply,
      contextResult.getMode(),
    )
  } catch (err) {
    // If streaming was started, send error event to client and re-throw for logging
    if (contextResult.isStarted()) {
      const connectionId = contextResult.getConnectionId()
      if (connectionId) {
        await handleSSEError(contextResult.sseReply, controller, connectionId, err)
      }
      // Re-throw for Fastify's onError hooks (status can't change after headers sent)
      throw err
    }

    // Streaming not started - explicitly send HTTP error response
    // We must handle this ourselves because the zod serializer compiler
    // interferes with Fastify's default error handler for SSE routes,
    // causing thrown errors to return 200 with empty SSE response instead of 500
    const message = isErrorLike(err) ? err.message : 'Internal Server Error'
    reply.code(500).type('application/json').send({
      statusCode: 500,
      error: 'Internal Server Error',
      message,
    })
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
    sse: buildSSEConfig(options), // Enable SSE support with optional per-route config
    schema: {
      params: contract.params,
      querystring: contract.query,
      headers: contract.requestHeaders,
      ...(contract.requestBody && { body: contract.requestBody }),
      // Note: response schema for sync mode could be added here
    },
    handler: async (request, reply) => {
      // Determine mode based on Accept header
      const mode = determineMode(request.headers.accept, defaultMode)

      if (mode === 'json') {
        return await handleSyncMode(contract, handlers, request, reply)
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
    sse: buildSSEConfig(options), // Enable SSE support with optional per-route config
    schema: {
      params: contract.params,
      querystring: contract.query,
      headers: contract.requestHeaders,
      ...(contract.requestBody && { body: contract.requestBody }),
    },
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Core SSE route handler must coordinate context, error handling, and result processing
    handler: async (request, reply) => {
      // Create SSE context for deferred header sending
      const contextResult = createSSEContext(
        controller,
        request,
        reply,
        contract.sseEvents,
        options,
        'SSE',
      )

      // Call user handler with (request, sse) signature
      // Handler returns SSEHandlerResult indicating how to manage response
      try {
        // biome-ignore lint/suspicious/noExplicitAny: Request and SSEContext types are validated by FastifySSEHandlerConfig
        const result = await handlers.sse(request as any, contextResult.sseContext as any)

        // Check for forgotten start() detection
        // Handler must either start streaming OR send a response
        // Note: With autoClose mode, handlers return void after start(), which is valid
        if (!contextResult.isStarted() && (!result || result._type !== 'respond')) {
          throw new Error(
            'SSE handler must either send a response (sse.respond()) ' +
              'or start streaming (sse.start()). Handler returned without doing either.',
          )
        }

        // Process the result
        await processSSEHandlerResult(
          result,
          controller,
          contextResult.getConnectionId(),
          contextResult.connectionClosed,
          reply,
          contextResult.getMode(),
        )
      } catch (err) {
        // If streaming was started, send error event to client and re-throw for logging
        if (contextResult.isStarted()) {
          const connectionId = contextResult.getConnectionId()
          if (connectionId) {
            await handleSSEError(contextResult.sseReply, controller, connectionId, err)
          }
          // Re-throw for Fastify's onError hooks (status can't change after headers sent)
          throw err
        }

        // Streaming not started - explicitly send HTTP error response
        // We must handle this ourselves because the zod serializer compiler
        // interferes with Fastify's default error handler for SSE routes,
        // causing thrown errors to return 200 with empty SSE response instead of 500
        const message = isErrorLike(err) ? err.message : 'Internal Server Error'
        reply.code(500).type('application/json').send({
          statusCode: 500,
          error: 'Internal Server Error',
          message,
        })
      }
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
 * This overload handles dual-mode route handlers (endpoints that support both sync and SSE responses).
 * The response mode is determined by the Accept header.
 *
 * @param controller - The dual-mode controller instance
 * @param handler - The dual-mode route handler (from buildHandler)
 * @returns Fastify route options
 */
export function buildFastifyRoute<
  Contracts extends Record<string, AnyDualModeContractDefinition>,
  Contract extends AnyDualModeContractDefinition,
>(
  controller: AbstractDualModeController<Contracts>,
  handler: DualModeRouteHandler<Contract>,
): RouteOptions

/**
 * Build a Fastify route configuration for an SSE endpoint.
 *
 * This overload handles SSE route handlers (endpoints that only stream SSE responses).
 * Integrates with @fastify/sse and the AbstractSSEController for connection management.
 *
 * @param controller - The SSE controller instance
 * @param handler - The SSE route handler (from buildHandler)
 * @returns Fastify route options
 */
export function buildFastifyRoute<
  Contracts extends Record<string, AnySSEContractDefinition>,
  Contract extends AnySSEContractDefinition,
>(controller: AbstractSSEController<Contracts>, handler: SSERouteHandler<Contract>): RouteOptions

/**
 * Build a Fastify route configuration for SSE or dual-mode endpoints.
 *
 * This unified function creates routes that integrate with @fastify/sse. The handler type
 * determines the behavior:
 *
 * - **SSE route handlers**: Creates SSE-only routes that stream events
 * - **Dual-mode route handlers**: Creates routes that branch on Accept header
 *   - `Accept: application/json` → Sync response
 *   - `Accept: text/event-stream` → SSE streaming
 *
 * @example
 * ```typescript
 * // SSE-only route with deferred headers (can return early)
 * const sseHandler = buildHandler(notificationsContract, {
 *   sse: async (request, sse) => {
 *     const entity = await db.find(request.params.id)
 *     if (!entity) {
 *       return sse.respond(404, { error: 'Not found' })
 *     }
 *     const session = sse.start('keepAlive')
 *     await session.send('notification', { message: 'Hello!' })
 *   },
 * }, { onConnect: ..., onClose: ... })
 *
 * // Dual-mode route
 * const dualModeHandler = buildHandler(chatCompletionContract, {
 *   sync: (request, reply) => {
 *     return { reply: 'Hello', usage: { tokens: 1 } }
 *   },
 *   sse: async (request, sse) => {
 *     const session = sse.start('autoClose')
 *     await session.send('chunk', { delta: 'Hello' })
 *     await session.send('done', { usage: { total: 1 } })
 *   },
 * }, { preHandler: authHandler })
 *
 * // Register with Fastify
 * app.route(buildFastifyRoute(notificationsController, sseHandler))
 * app.route(buildFastifyRoute(chatController, dualModeHandler))
 * ```
 */
export function buildFastifyRoute(
  controller:
    | AbstractDualModeController<Record<string, AnyDualModeContractDefinition>>
    | AbstractSSEController<Record<string, AnySSEContractDefinition>>,
  handler:
    | DualModeRouteHandler<AnyDualModeContractDefinition>
    | SSERouteHandler<AnySSEContractDefinition>,
): RouteOptions {
  if (handler.__type === 'DualModeRouteHandler') {
    const dualModeHandler = handler as DualModeRouteHandler<AnyDualModeContractDefinition>
    return buildDualModeRouteInternal(
      controller as AbstractDualModeController<Record<string, AnyDualModeContractDefinition>>,
      {
        contract: dualModeHandler.contract,
        handlers: dualModeHandler.handlers,
        options: dualModeHandler.options,
      },
    )
  }

  if (handler.__type === 'SSERouteHandler') {
    const sseHandler = handler as SSERouteHandler<AnySSEContractDefinition>
    return buildSSERouteInternal(
      controller as AbstractSSEController<Record<string, AnySSEContractDefinition>>,
      {
        contract: sseHandler.contract,
        handlers: sseHandler.handlers,
        options: sseHandler.options,
      },
    )
  }

  // Unknown handler type - throw descriptive error
  const unknownHandler = handler as { __type?: unknown; contract?: { pathResolver?: unknown } }
  const handlerType = unknownHandler.__type ?? 'undefined'
  const handlerIdentity =
    typeof unknownHandler.contract?.pathResolver === 'function'
      ? `contract with path "${unknownHandler.contract.pathResolver({})}"`
      : 'unknown handler'
  throw new Error(
    `buildFastifyRoute received unexpected handler.__type: "${handlerType}" for ${handlerIdentity}. ` +
      `Expected "DualModeRouteHandler" (for use with AbstractDualModeController and buildDualModeRouteInternal) ` +
      `or "SSERouteHandler" (for use with AbstractSSEController and buildSSERouteInternal). ` +
      `Ensure the handler was created using buildHandler().`,
  )
}
