import type { SSERouteKind } from '@fastify/sse'
import type {
  AnyDualModeContractDefinition,
  AnySSEContractDefinition,
  HttpStatusCode,
} from '@lokalise/api-contracts'
import type { ExtendedFastifySchema } from '@lokalise/fastify-api-contracts'
import { InternalError } from '@lokalise/node-core'
import type { FastifyReply, RouteOptions } from 'fastify'
import type { z } from 'zod'
import { ZodObject } from 'zod'
import type { AbstractDualModeController } from '../dualmode/AbstractDualModeController.ts'
import { isErrorLike } from '../errorUtils.ts'
import { attachRouteStreamingMode } from '../gateway/routeStreaming.ts'
import type { AbstractSSEController } from '../sse/AbstractSSEController.ts'
import type {
  DualModeRouteHandler,
  FastifyDualModeHandlerConfig,
  FastifyDualModeRouteOptions,
  FastifySSEHandlerConfig,
  FastifySSERouteOptions,
  SSERouteHandler,
} from './fastifyRouteTypes.ts'
import {
  createSSEContext,
  determineMode,
  extractPathTemplate,
  handleSSEError,
  hasHttpStatusCode,
} from './fastifyRouteUtils.ts'
import { buildSseResponseSchemas } from './sseResponseSchema.ts'

// Re-export for convenience
export { extractPathTemplate }

/** Shape of the `sse` route option handed to `@fastify/sse`. */
type SSERouteConfig = {
  kind: SSERouteKind
  serializer?: (data: unknown) => string
  /**
   * Whether the plugin's keep-alive heartbeat runs for this route.
   *
   * A boolean is all `@fastify/sse` reads per route; the interval itself comes from
   * `app.register(fastifySSE, { heartbeatInterval })` and is shared by every route.
   */
  heartbeat?: boolean
}

/**
 * Default `@fastify/sse` route kind used by both SSE-only and dual-mode routes.
 *
 * `'manual'` disables the plugin's `Accept` header negotiation entirely: `reply.sse` is
 * always attached and the route handler decides at runtime whether to stream or to send a
 * regular HTTP response. That matches what the handlers this builder produces already do,
 * and it is the only kind that is safe for every shape of route:
 *
 * - SSE-only handlers have a single code path that calls `sse.start()`. Under the plugin's
 *   `sse: true` default (`kind: 'legacy'`) a client that does not send an explicit
 *   `text/event-stream` token - a wildcard `Accept` header, `Accept: application/json`, or
 *   no `Accept` header at all, which is what most non-browser clients and OpenAPI-generated
 *   clients send - leaves `reply.sse` undefined while still running the handler, so the
 *   first `sse.start()` throws and the request 500s.
 * - Dual-mode handlers negotiate themselves via `determineMode()`, which honours
 *   `defaultMode`. Under a plugin-side gate, `defaultMode: 'sse'` combined with a
 *   non-specific `Accept` header hits the same 500.
 * - `sse.respond()` (an early HTTP response before streaming starts) stays reachable for
 *   every client. `kind: 'only'` would cut that off for JSON clients: its gate admits a
 *   missing `Accept` header plus the `*\/*` and `text/*` wildcards, but answers `406` to
 *   every other concrete media type, `application/json` included.
 *
 * Override per route with the `kind` route option when different semantics are wanted -
 * `'only'` on an SSE-only route for `406 Not Acceptable` content negotiation, or `'dual'`
 * on a dual-mode route to let the plugin gate before the handler runs.
 */
const DEFAULT_SSE_ROUTE_KIND: SSERouteKind = 'manual'

/**
 * Build the SSE config object for route options.
 *
 * Always returns the object form with an explicit `kind`: omitting it (or passing
 * `sse: true`) makes `@fastify/sse` fall back to its `'legacy'` kind, which applies a
 * strict `Accept` gate and leaves `reply.sse` undefined for clients that do not ask
 * for `text/event-stream` explicitly.
 *
 * `heartbeat` is a boolean: the plugin only supports turning the heartbeat on or off per
 * route, while the interval is set once for all routes at plugin registration.
 */
function buildSSEConfig(
  options: FastifySSERouteOptions | FastifyDualModeRouteOptions | undefined,
): SSERouteConfig {
  const sseConfig: SSERouteConfig = { kind: options?.kind ?? DEFAULT_SSE_ROUTE_KIND }

  if (options?.serializer) {
    sseConfig.serializer = options.serializer
  }

  if (options?.heartbeat !== undefined) {
    sseConfig.heartbeat = options.heartbeat
  }

  return sseConfig
}

/**
 * Validate response body against the successResponseBodySchema (for 2xx success responses).
 *
 * Only validates if the contract defines a successResponseBodySchema.
 * Validation errors are not exposed to clients - only logged internally.
 *
 * @param contract - The dual-mode contract containing the successResponseBodySchema
 * @param response - The response body to validate
 * @throws {InternalError} When validation fails with errorCode 'RESPONSE_VALIDATION_FAILED'
 */
function validateSyncResponseBody(
  contract: AnyDualModeContractDefinition,
  response: unknown,
): void {
  const schema = contract.successResponseBodySchema
  if (!schema) return

  const result = schema.safeParse(response)
  if (!result.success) {
    throw new InternalError({
      message: 'Internal Server Error',
      errorCode: 'RESPONSE_VALIDATION_FAILED',
      details: { validationError: result.error.message },
    })
  }
}

/**
 * Validate response body against responseSchemasByStatusCode for a specific HTTP status code.
 *
 * Used for non-2xx responses in dual-mode sync handlers and for sse.respond() in SSE handlers.
 * Typically used for error responses, but can validate any status code with a defined schema.
 * Only validates if the contract defines a schema for the given status code.
 * Validation errors are not exposed to clients - only logged internally.
 *
 * @param responseSchemasByStatusCode - Map of HTTP status codes to Zod schemas (e.g., { 400: z.object(...), 404: z.object(...) })
 * @param statusCode - The HTTP status code of the response
 * @param response - The response body to validate
 * @throws {InternalError} When validation fails with errorCode 'RESPONSE_VALIDATION_FAILED' and statusCode in details
 *
 * @example
 * ```typescript
 * // In a contract definition:
 * const contract = buildContract({
 *   visibility: 'public',
 *   responseBodySchemasByStatusCode: {
 *     400: z.object({ error: z.string(), details: z.array(z.string()) }),
 *     404: z.object({ error: z.string(), resourceId: z.string() }),
 *   },
 *   // ... other contract properties
 * })
 *
 * // In a handler returning a 404:
 * sync: (request, reply) => {
 *   reply.code(404)
 *   return { error: 'Not Found', resourceId: 'item-123' }  // Validated against 404 schema
 * }
 * ```
 */
function validateResponseByStatusCode(
  responseSchemasByStatusCode: Partial<Record<HttpStatusCode, z.ZodTypeAny>> | undefined,
  statusCode: number,
  response: unknown,
): void {
  if (!responseSchemasByStatusCode) return

  // Access the schema - keys may be stored as strings due to JavaScript object behavior
  const schema = (responseSchemasByStatusCode as Record<string, z.ZodTypeAny | undefined>)[
    String(statusCode)
  ]
  if (!schema) return

  const result = schema.safeParse(response)
  if (!result.success) {
    throw new InternalError({
      message: 'Internal Server Error',
      errorCode: 'RESPONSE_VALIDATION_FAILED',
      details: { statusCode, validationError: result.error.message },
    })
  }
}

/**
 * Validate response headers against the responseHeaders schema.
 * Throws InternalError with generic message - validation details are in the error details, not exposed to clients.
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
      message: 'Internal Server Error',
      errorCode: 'RESPONSE_HEADERS_VALIDATION_FAILED',
      details: { validationError: result.error.message },
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

  // If the handler already called reply.send() directly (e.g. reply.status(200).send(data)),
  // the reply is already sent. Skip validation and sending to avoid errors.
  // Note: this means response validation is bypassed when handlers send replies directly.
  // Handlers should return the response body and let the framework send it.
  if (reply.sent) {
    request.log.warn({
      msg: 'Sync handler sent response directly, bypassing response validation',
      tag: 'response_sent_directly',
      method: request.method,
      url: request.url,
      routePath: request.routeOptions?.url,
      reqId: request.id,
    })
    return
  }

  // Get the status code that was set by the handler (defaults to 200)
  const statusCode = reply.statusCode ?? 200

  // Validate response based on status code:
  // - 2xx success codes: use successResponseBodySchema
  // - Other codes: use responseBodySchemasByStatusCode if defined
  try {
    if (statusCode >= 200 && statusCode < 300) {
      validateSyncResponseBody(contract, response)
    } else {
      validateResponseByStatusCode(contract.responseBodySchemasByStatusCode, statusCode, response)
    }
  } catch (err) {
    // Reset status code to 500 for validation errors
    // This is needed because the handler may have set a different status code (e.g., 404)
    // and Fastify would use that status code when sending the error response
    reply.code(500)
    throw err
  }

  // Explicitly set content-type to override SSE default (from sse: true option)
  reply.type('application/json')

  validateResponseHeaders(contract.responseHeaderSchema, reply)

  return reply.send(response)
}

/**
 * Process SSE handler result and manage connection lifecycle.
 */
async function processSSEHandlerResult(
  responseData: { code: number; body: unknown } | undefined,
  controller:
    | AbstractDualModeController<Record<string, AnyDualModeContractDefinition>>
    | AbstractSSEController<Record<string, AnySSEContractDefinition>>,
  connectionId: string | undefined,
  connectionClosed: Promise<void>,
  reply: FastifyReply,
  mode: 'autoClose' | 'keepAlive' | undefined,
  responseSchemasByStatusCode?: Partial<Record<HttpStatusCode, z.ZodTypeAny>>,
): Promise<void> {
  // Check if handler called sse.respond() (early return before streaming started)
  if (responseData) {
    // Validate sse.respond() body against responseSchemasByStatusCode if defined
    validateResponseByStatusCode(responseSchemasByStatusCode, responseData.code, responseData.body)

    // Send HTTP response (early return before streaming started).
    // Clean up SSE-specific headers that @fastify/sse sets early in the lifecycle.
    // Not strictly necessary, but avoids confusing headers on JSON responses.
    reply.removeHeader('cache-control')
    reply.removeHeader('x-accel-buffering')
    // Critical: override content-type from text/event-stream to application/json,
    // otherwise the zod serializer compiler won't serialize the body correctly.
    reply.type('application/json').code(responseData.code).send(responseData.body)
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
    contract.serverSentEventSchemas,
    options,
    'dual-mode SSE',
  )

  try {
    // biome-ignore lint/suspicious/noExplicitAny: SSEContext types are validated by FastifyDualModeHandlerConfig
    await handlers.sse(request, contextResult.sseContext as any)

    // Check for forgotten start() detection
    // Handler must either start streaming OR call sse.respond()
    // Note: With autoClose mode, handlers return void after start(), which is valid
    if (!contextResult.isStarted() && !contextResult.hasResponse()) {
      throw new Error(
        'SSE handler must either send a response (sse.respond()) ' +
          'or start streaming (sse.start()). Handler returned without doing either.',
      )
    }

    // Process the result
    await processSSEHandlerResult(
      contextResult.getResponseData(),
      controller,
      contextResult.getConnectionId(),
      contextResult.connectionClosed,
      reply,
      contextResult.getMode(),
      contract.responseBodySchemasByStatusCode,
    )
  } catch (err) {
    // If streaming was started, send error event to client and re-throw for logging
    if (contextResult.isStarted()) {
      const connectionId = contextResult.getConnectionId()
      if (connectionId) {
        await handleSSEError(contextResult.sseReply, controller, connectionId, err, options?.logger)
      }
      // Re-throw for Fastify's onError hooks (status can't change after headers sent)
      throw err
    }

    // Streaming not started - explicitly send HTTP error response
    // We must handle this ourselves because the zod serializer compiler
    // interferes with Fastify's default error handler for SSE routes,
    // causing thrown errors to return 200 with empty SSE response instead of 500
    const message = isErrorLike(err) ? err.message : 'Internal Server Error'
    // Respect httpStatusCode from errors like PublicNonRecoverableError
    const statusCode = hasHttpStatusCode(err) ? err.httpStatusCode : 500
    const statusText = statusCode >= 500 ? 'Internal Server Error' : 'Error'
    // Sent pre-serialized: Fastify skips the response serializer for string payloads, so this
    // envelope reaches the client intact even when the contract declares a different body for
    // `statusCode`. Serializing it against that schema would drop `message`.
    reply
      .code(statusCode)
      .type('application/json')
      .send(JSON.stringify({ statusCode, error: statusText, message }))
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
  if (!(contract.requestPathParamsSchema instanceof ZodObject)) {
    throw new InternalError({
      message: `Route params schema must be a ZodObject for path template extraction, got ${contract.requestPathParamsSchema?.constructor.name ?? 'undefined'}`,
      errorCode: 'INVALID_PARAMS_SCHEMA',
    })
  }
  const url = extractPathTemplate(contract.pathResolver, contract.requestPathParamsSchema)

  // `kind: 'dual'` hands Accept negotiation to @fastify/sse, which admits SSE only for an
  // explicit `text/event-stream` token. `determineMode()` then negotiates a second time
  // inside the handler and falls back to `defaultMode` for anything non-specific, so with
  // `defaultMode: 'sse'` a wildcard or absent Accept header takes the SSE branch after the
  // plugin already declined to attach `reply.sse` - a guaranteed 500 on every such request.
  // The two negotiators only agree when the fallback is JSON, so reject the combination at
  // route-build time rather than letting it fail per request. `kind: 'manual'` (the default)
  // performs no plugin-side gating and supports `defaultMode: 'sse'` fine.
  if (options?.kind === 'dual' && defaultMode === 'sse') {
    throw new InternalError({
      message:
        `Dual-mode route ${contract.method.toUpperCase()} ${url} cannot combine kind: "dual" ` +
        'with defaultMode: "sse": @fastify/sse would decline to attach reply.sse for ' +
        'wildcard or absent Accept headers while the handler still selects SSE mode. ' +
        'Use kind: "manual" (the default) instead.',
      errorCode: 'INVALID_SSE_ROUTE_KIND',
      details: { url, method: contract.method, defaultMode, kind: options.kind },
    })
  }

  const schema: ExtendedFastifySchema = {
    params: contract.requestPathParamsSchema,
    querystring: contract.requestQuerySchema,
    headers: contract.requestHeaderSchema,
    description: contract.description,
    summary: contract.summary,
    tags: contract.tags,
    hide: contract.visibility !== 'public',
    ...(contract.requestBodySchema && { body: contract.requestBodySchema }),
    // 200 describes both branches: the JSON sync body and the SSE event stream.
    // `isEmptyResponseExpected` contracts have no sync body to describe, so they get the
    // stream alone rather than a schema that would serialize an empty response.
    response: buildSseResponseSchemas(
      contract.serverSentEventSchemas,
      contract.responseBodySchemasByStatusCode,
      contract.isEmptyResponseExpected ? undefined : contract.successResponseBodySchema,
    ),
  }

  const routeOptions: RouteOptions = {
    ...(options?.contractMetadataToRouteMapper?.(contract.metadata) ?? {}),
    method: contract.method,
    url,
    sse: buildSSEConfig(options), // Enable SSE support with explicit kind + optional per-route config
    schema,
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

  // Carry the fallback branch into the manifest: a gateway splitting this
  // route needs to know where a request with no (or a wildcard) Accept header
  // goes, or it applies request-shaped timeouts to an SSE response.
  return attachRouteStreamingMode(routeOptions, 'dual', defaultMode)
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
  if (!(contract.requestPathParamsSchema instanceof ZodObject)) {
    throw new InternalError({
      message: `Route params schema must be a ZodObject for path template extraction, got ${contract.requestPathParamsSchema?.constructor.name ?? 'undefined'}`,
      errorCode: 'INVALID_PARAMS_SCHEMA',
    })
  }
  const url = extractPathTemplate(contract.pathResolver, contract.requestPathParamsSchema)

  const schema: ExtendedFastifySchema = {
    params: contract.requestPathParamsSchema,
    querystring: contract.requestQuerySchema,
    headers: contract.requestHeaderSchema,
    description: contract.description,
    summary: contract.summary,
    tags: contract.tags,
    hide: contract.visibility !== 'public',
    ...(contract.requestBodySchema && { body: contract.requestBodySchema }),
    response: buildSseResponseSchemas(
      contract.serverSentEventSchemas,
      contract.responseBodySchemasByStatusCode,
    ),
  }

  const routeOptions: RouteOptions = {
    ...(options?.contractMetadataToRouteMapper?.(contract.metadata) ?? {}),
    method: contract.method,
    url,
    sse: buildSSEConfig(options), // Enable SSE support with explicit kind + optional per-route config
    schema,
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Core SSE route handler must coordinate context, error handling, and result processing
    handler: async (request, reply) => {
      // Create SSE context for deferred header sending
      const contextResult = createSSEContext(
        controller,
        request,
        reply,
        contract.serverSentEventSchemas,
        options,
        'SSE',
      )

      // Call user handler with (request, sse) signature
      // Handler can call sse.respond() without returning it, or return it - both work
      try {
        // biome-ignore lint/suspicious/noExplicitAny: Request and SSEContext types are validated by FastifySSEHandlerConfig
        await handlers.sse(request as any, contextResult.sseContext as any)

        // Check for forgotten start() detection
        // Handler must either start streaming OR call sse.respond()
        // Note: With autoClose mode, handlers return void after start(), which is valid
        if (!contextResult.isStarted() && !contextResult.hasResponse()) {
          throw new Error(
            'SSE handler must either send a response (sse.respond()) ' +
              'or start streaming (sse.start()). Handler returned without doing either.',
          )
        }

        // Process the result
        await processSSEHandlerResult(
          contextResult.getResponseData(),
          controller,
          contextResult.getConnectionId(),
          contextResult.connectionClosed,
          reply,
          contextResult.getMode(),
          contract.responseBodySchemasByStatusCode,
        )
      } catch (err) {
        // If streaming was started, send error event to client and re-throw for logging
        if (contextResult.isStarted()) {
          const connectionId = contextResult.getConnectionId()
          if (connectionId) {
            await handleSSEError(
              contextResult.sseReply,
              controller,
              connectionId,
              err,
              options?.logger,
            )
          }
          // Re-throw for Fastify's onError hooks (status can't change after headers sent)
          throw err
        }

        // Streaming not started - explicitly send HTTP error response
        // We must handle this ourselves because the zod serializer compiler
        // interferes with Fastify's default error handler for SSE routes,
        // causing thrown errors to return 200 with empty SSE response instead of 500
        const message = isErrorLike(err) ? err.message : 'Internal Server Error'
        // Respect httpStatusCode from errors like PublicNonRecoverableError
        const statusCode = hasHttpStatusCode(err) ? err.httpStatusCode : 500
        const statusText = statusCode >= 500 ? 'Internal Server Error' : 'Error'
        // Sent pre-serialized: Fastify skips the response serializer for string payloads, so
        // this envelope reaches the client intact even when the contract declares a different
        // body for `statusCode`. Serializing it against that schema would drop `message`.
        reply
          .code(statusCode)
          .type('application/json')
          .send(JSON.stringify({ statusCode, error: statusText, message }))
      }
    },
  }

  // Add preHandler hooks for authentication
  if (options?.preHandler) {
    routeOptions.preHandler = options.preHandler
  }

  return attachRouteStreamingMode(routeOptions, 'sse')
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
