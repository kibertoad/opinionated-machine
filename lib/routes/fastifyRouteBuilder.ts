import { InternalError } from '@lokalise/node-core'
import type { FastifyReply, RouteOptions } from 'fastify'
import type { z } from 'zod'
import { ZodObject } from 'zod'
import type { AbstractDualModeController } from '../dualmode/AbstractDualModeController.ts'
import {
  type AnyDualModeContractDefinition,
  isVerboseContract,
} from '../dualmode/dualModeContracts.ts'
import type { AbstractSSEController } from '../sse/AbstractSSEController.ts'
import type { AnySSEContractDefinition } from '../sse/sseContracts.ts'
import type {
  FastifyDualModeHandlerConfig,
  FastifySSEHandlerConfig,
  FastifySSERouteOptions,
  SSEHandlerResult,
} from './fastifyRouteTypes.ts'
import {
  createSSEContext,
  determineMode,
  determineSyncFormat,
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
 * Validate response body against the appropriate schema.
 * For simplified contracts, uses jsonResponse.
 * For verbose contracts, uses the schema for the specified contentType.
 */
function validateResponseBody(
  contract: AnyDualModeContractDefinition,
  response: unknown,
  contentType?: string,
): void {
  let schema: z.ZodTypeAny | undefined

  if (isVerboseContract(contract)) {
    // Multi-format: use schema for the content type
    if (!contentType) {
      throw new InternalError({
        message: 'Content-Type is required for multi-format response validation',
        errorCode: 'MISSING_CONTENT_TYPE',
      })
    }
    schema = contract.multiFormatResponses[contentType]
    if (!schema) {
      throw new InternalError({
        message: `No schema defined for Content-Type '${contentType}' in multiFormatResponses. Available formats: ${Object.keys(contract.multiFormatResponses).join(', ')}`,
        errorCode: 'UNKNOWN_CONTENT_TYPE',
      })
    }
  } else {
    // Simplified: use jsonResponse
    schema = contract.jsonResponse
  }

  if (!schema) return

  const result = schema.safeParse(response)
  if (!result.success) {
    throw new InternalError({
      message: `Response validation failed for ${contentType ?? 'application/json'}: ${result.error.message}`,
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
 * Handle simplified JSON mode request (single format).
 */
async function handleJsonMode<Contract extends AnyDualModeContractDefinition>(
  contract: Contract,
  handlers: FastifyDualModeHandlerConfig<Contract>['handlers'],
  // biome-ignore lint/suspicious/noExplicitAny: Request types are validated by Fastify schema
  request: any,
  reply: FastifyReply,
) {
  // biome-ignore lint/suspicious/noExplicitAny: Handler type depends on contract
  const response = await (handlers as any).json(request, reply)

  validateResponseBody(contract, response, 'application/json')

  // Explicitly set content-type to override SSE default (from sse: true option)
  reply.type('application/json')

  validateResponseHeaders(contract.responseHeaders, reply)

  return reply.send(response)
}

/**
 * Handle verbose multi-format sync mode request.
 */
async function handleSyncMode<Contract extends AnyDualModeContractDefinition>(
  contract: Contract,
  handlers: FastifyDualModeHandlerConfig<Contract>['handlers'],
  // biome-ignore lint/suspicious/noExplicitAny: Request types are validated by Fastify schema
  request: any,
  reply: FastifyReply,
  contentType: string,
) {
  // biome-ignore lint/suspicious/noExplicitAny: Handler type depends on contract
  const syncHandlers = (handlers as any).sync
  if (!syncHandlers || !syncHandlers[contentType]) {
    throw new InternalError({
      message: `No handler found for content type: ${contentType}`,
      errorCode: 'HANDLER_NOT_FOUND',
    })
  }

  const response = await syncHandlers[contentType](request, reply)

  validateResponseBody(contract, response, contentType)

  // Set the content type
  reply.type(contentType)

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
): Promise<void> {
  switch (result._type) {
    case 'respond':
      // Send HTTP response (early return before streaming started).
      // Clean up SSE-specific headers that @fastify/sse sets early in the lifecycle.
      // Not strictly necessary, but avoids confusing headers on JSON responses.
      reply.removeHeader('cache-control')
      reply.removeHeader('x-accel-buffering')
      // Critical: override content-type from text/event-stream to application/json,
      // otherwise the zod serializer compiler won't serialize the body correctly.
      reply.type('application/json').code(result.code).send(result.body)
      break

    case 'close':
      // Request-response streaming: close session after handler completes
      if (connectionId) {
        controller.closeConnection(connectionId)
      }
      break

    case 'keepAlive':
      // Long-lived session: wait for client to disconnect
      await connectionClosed
      break
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
    contract.events,
    options,
    'dual-mode SSE',
  )

  try {
    // biome-ignore lint/suspicious/noExplicitAny: SSEContext types are validated by FastifyDualModeHandlerConfig
    const result = await handlers.sse(request, contextResult.sseContext as any)

    // Check for forgotten start() detection
    // Handle case where result is undefined/null (handler forgot to return)
    if (!result || (result._type !== 'respond' && !contextResult.isStarted())) {
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
      // Note: response schema for JSON mode could be added here
    },
    handler: async (request, reply) => {
      // Check if this is a verbose multi-format contract
      if (isVerboseContract(contract)) {
        const supportedFormats = Object.keys(contract.multiFormatResponses)
        const formatResult = determineSyncFormat(
          request.headers.accept,
          supportedFormats,
          supportedFormats[0],
        )

        if (formatResult.mode === 'sse') {
          return await handleSSEMode(controller, contract, handlers, request, reply, options)
        }

        return await handleSyncMode(contract, handlers, request, reply, formatResult.contentType)
      }

      // Simplified single-JSON-format contract
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
        contract.events,
        options,
        'SSE',
      )

      // Call user handler with (request, sse) signature
      // Handler returns SSEHandlerResult indicating how to manage response
      try {
        // biome-ignore lint/suspicious/noExplicitAny: Request and SSEContext types are validated by FastifySSEHandlerConfig
        const result = await handlers.sse(request as any, contextResult.sseContext as any)

        // Check for forgotten start() detection
        // Handle case where result is undefined/null (handler forgot to return)
        if (!result || (result._type !== 'respond' && !contextResult.isStarted())) {
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
 * This overload handles dual-mode contracts (endpoints that support both JSON and SSE responses).
 * The response mode is determined by the Accept header.
 *
 * @param controller - The dual-mode controller instance
 * @param config - The dual-mode handler configuration
 * @returns Fastify route options
 */
export function buildFastifyRoute<
  Contracts extends Record<string, AnyDualModeContractDefinition>,
  Contract extends AnyDualModeContractDefinition,
>(
  controller: AbstractDualModeController<Contracts>,
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
export function buildFastifyRoute<
  Contracts extends Record<string, AnySSEContractDefinition>,
  Contract extends AnySSEContractDefinition,
>(
  controller: AbstractSSEController<Contracts>,
  config: FastifySSEHandlerConfig<Contract>,
): RouteOptions

/**
 * Build a Fastify route configuration for SSE or dual-mode endpoints.
 *
 * This unified function creates routes that integrate with @fastify/sse. The contract type
 * determines the behavior:
 *
 * - **SSE contracts** (no `jsonResponse`): Creates SSE-only routes that stream events
 * - **Dual-mode contracts** (has `jsonResponse`): Creates routes that branch on Accept header
 *   - `Accept: application/json` → JSON response
 *   - `Accept: text/event-stream` → SSE streaming
 *
 * @example
 * ```typescript
 * // SSE-only route with deferred headers (can return early)
 * const sseRoute = buildFastifyRoute(notificationsController, {
 *   contract: notificationsContract,
 *   handlers: {
 *     sse: async (request, sse) => {
 *       const entity = await db.find(request.params.id)
 *       if (!entity) {
 *         return sse.respond(404, { error: 'Not found' })
 *       }
 *       const session = sse.start()
 *       await session.send('notification', { message: 'Hello!' })
 *       return session.keepAlive()
 *     },
 *   },
 * })
 *
 * // Dual-mode route
 * const dualModeRoute = buildFastifyRoute(chatController, {
 *   contract: chatCompletionContract,
 *   handlers: {
 *     json: async (request, reply) => {
 *       return { reply: 'Hello', usage: { tokens: 1 } }
 *     },
 *     sse: async (request, sse) => {
 *       const session = sse.start()
 *       await session.send('chunk', { delta: 'Hello' })
 *       await session.send('done', { usage: { total: 1 } })
 *       return session.close()
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
  // Discriminate by checking for dual-mode handlers:
  // - Simplified: has 'json' and 'sse'
  // - Verbose: has 'sync' and 'sse'
  // SSE-only handlers have only 'sse'
  if ('handlers' in config && ('json' in config.handlers || 'sync' in config.handlers)) {
    // Dual-mode config has handlers with either (json and sse) or (sync and sse)
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
