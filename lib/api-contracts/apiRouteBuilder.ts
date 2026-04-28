import { randomUUID } from 'node:crypto'
import {
  type ApiContract,
  type ApiContractResponse,
  ContractNoBody,
  getSseSchemaByEventName,
  type HttpStatusCode,
  hasAnySuccessSseResponse,
  isAnyOfResponses,
  isBlobResponse,
  isSseResponse,
  isTextResponse,
  mapApiContractToPath,
  type SseSchemaByEventName,
  SUCCESSFUL_HTTP_STATUS_CODES,
} from '@lokalise/api-contracts'
import { InternalError } from '@lokalise/node-core'
import type { FastifyReply, RouteOptions } from 'fastify'
import type { z } from 'zod/v4'
import type {
  SSEContext,
  SSESession,
  SSESessionMode,
  SSEStartOptions,
  SSEStreamMessage,
  SyncModeReply,
} from '../routes/fastifyRouteTypes.ts'
import type { SSEReply } from '../routes/fastifyRouteUtils.ts'
import { determineMode, hasHttpStatusCode, isErrorLike } from '../routes/fastifyRouteUtils.ts'
import type { SSERoomManager } from '../sse/rooms/SSERoomManager.ts'
import type { ApiRouteHandler, ApiRouteOptions, InferApiHandler } from './apiHandlerTypes.ts'

/**
 * Room infrastructure injected by AbstractApiController when rooms are enabled.
 * @internal
 */
export type ApiRouteInternalRoomContext = {
  roomManager: SSERoomManager
  registerSession: (session: SSESession) => void
  unregisterSession: (id: string) => void
}

// ============================================================================
// Internal Helpers — Response Mode
// ============================================================================

type ResponseMode = 'non-sse' | 'sse' | 'dual'

function isSuccessResponseDual(value: ApiContractResponse): boolean {
  if (value === ContractNoBody || isTextResponse(value) || isBlobResponse(value)) return true
  if (!isSseResponse(value) && !isAnyOfResponses(value)) return true
  if (isAnyOfResponses(value)) {
    return value.responses.some((response: ApiContractResponse) => !isSseResponse(response))
  }
  return false
}

function getContractResponseMode(contract: ApiContract): ResponseMode {
  if (!hasAnySuccessSseResponse(contract)) return 'non-sse'
  for (const code of SUCCESSFUL_HTTP_STATUS_CODES) {
    const value = contract.responsesByStatusCode[code]
    if (value && isSuccessResponseDual(value)) return 'dual'
  }
  return 'sse'
}

function buildSSERouteConfig(
  options: ApiRouteOptions | undefined,
): true | { serializer?: (data: unknown) => string; heartbeatInterval?: number } {
  if (!options?.serializer && options?.heartbeatInterval === undefined) return true
  const sseConfig: { serializer?: (data: unknown) => string; heartbeatInterval?: number } = {}
  if (options.serializer) sseConfig.serializer = options.serializer
  if (options.heartbeatInterval !== undefined)
    sseConfig.heartbeatInterval = options.heartbeatInterval
  return sseConfig
}

// ============================================================================
// Internal Helpers — Sync Route
// ============================================================================

function getSchemaForStatusCode(contract: ApiContract, status: number): z.ZodType | null {
  const entry = contract.responsesByStatusCode[status as HttpStatusCode]

  if (
    !entry ||
    entry === ContractNoBody ||
    isSseResponse(entry) ||
    isTextResponse(entry) ||
    isBlobResponse(entry)
  ) {
    return null
  }

  if (isAnyOfResponses(entry)) {
    for (const anyResponse of entry.responses) {
      if (
        isSseResponse(anyResponse) ||
        isTextResponse(anyResponse) ||
        isBlobResponse(anyResponse)
      ) {
        return null
      }
      return anyResponse
    }

    return null
  } else {
    return entry
  }
}

function validateApiResponseHeaders(contract: ApiContract, reply: FastifyReply): void {
  const schema = contract.responseHeaderSchema
  if (!schema) {
    return
  }

  const result = schema.safeParse(reply.getHeaders())
  if (!result.success) {
    throw new InternalError({
      message: 'Internal Server Error',
      errorCode: 'RESPONSE_HEADERS_VALIDATION_FAILED',
      details: { validationError: result.error.message },
    })
  }
}

type MaybePromise<T> = T | Promise<T>

async function handleApiSyncRoute(
  contract: ApiContract,
  // biome-ignore lint/suspicious/noExplicitAny: Handler types are validated by InferApiHandler at the call site
  handler: (request: any, reply: SyncModeReply) => MaybePromise<{ status: number; body: unknown }>,
  // biome-ignore lint/suspicious/noExplicitAny: Request types are validated by Fastify schema
  request: any,
  reply: FastifyReply,
): Promise<void> {
  const { status, body } = await handler(request, reply as SyncModeReply)

  if (reply.sent) {
    request.log.warn({
      msg: 'Sync handler sent response directly, bypassing response validation',
      tag: 'response_sent_directly',
      method: request.method,
      url: request.url,
    })
    return
  }

  try {
    const schema = getSchemaForStatusCode(contract, status)
    if (schema) {
      const result = schema.safeParse(body)
      if (!result.success) {
        throw new InternalError({
          message: 'Internal Server Error',
          errorCode: 'RESPONSE_VALIDATION_FAILED',
          details: { validationError: result.error.message },
        })
      }
    }
  } catch (err) {
    reply.code(500)
    throw err
  }

  validateApiResponseHeaders(contract, reply)

  if (!reply.hasHeader('content-type')) {
    reply.type('application/json')
  }

  return reply.code(status).send(body) as unknown as undefined
}

// ============================================================================
// Internal Helpers — SSE Route (no controller, uses reply.sse directly)
// ============================================================================

function buildApiSSEContext(
  // biome-ignore lint/suspicious/noExplicitAny: Request types are validated by Fastify schema
  request: any,
  reply: FastifyReply,
  eventSchemas: SseSchemaByEventName,
  options: ApiRouteOptions | undefined,
  roomContext?: ApiRouteInternalRoomContext,
): {
  // biome-ignore lint/suspicious/noExplicitAny: SSE event schemas are contract-specific, cast at call site
  sseContext: SSEContext<any>
  isStarted: () => boolean
  hasResponse: () => boolean
  getResponseData: () => { code: number; body: unknown } | undefined
} {
  let started = false
  let responseData: { code: number; body: unknown } | undefined
  const sseReply = reply as SSEReply

  const sseContext: SSEContext = {
    start: <Context = unknown>(mode: SSESessionMode, startOptions?: SSEStartOptions<Context>) => {
      started = true

      if (mode === 'keepAlive') {
        sseReply.sse.keepAlive()
      }

      // sendHeaders() calls writeHead(200) but only queues headers in the buffer.
      // flushHeaders() forces them onto the wire so the client's fetch() returns.
      sseReply.sse.sendHeaders()
      reply.raw.flushHeaders()

      const connectionId = randomUUID()

      const send = async (
        eventName: string,
        data: unknown,
        sendOptions?: { id?: string; retry?: number },
      ): Promise<boolean> => {
        const schema = eventSchemas[eventName]
        if (schema) {
          const result = schema.safeParse(data)
          if (!result.success) {
            throw new InternalError({
              message: `SSE event validation failed for event "${eventName}": ${result.error.message}`,
              errorCode: 'RESPONSE_VALIDATION_FAILED',
            })
          }
        }
        try {
          await sseReply.sse.send({
            event: eventName,
            data,
            id: sendOptions?.id,
            retry: sendOptions?.retry,
          })
          return true
        } catch {
          return false
        }
      }

      const session: SSESession<typeof eventSchemas, Context> = {
        id: connectionId,
        request,
        reply,
        context: (startOptions?.context ?? {}) as Context,
        connectedAt: new Date(),
        // biome-ignore lint/suspicious/noExplicitAny: SSEEventSender generic is satisfied at handler call site
        send: send as any,
        isConnected: () => sseReply.sse.isConnected,
        getStream: () => sseReply.sse.stream(),
        sendStream: async (messages: AsyncIterable<SSEStreamMessage>) => {
          for await (const message of messages) {
            await send(message.event, message.data, { id: message.id, retry: message.retry })
          }
        },
        rooms: roomContext
          ? {
              join: (room: string | string[]) => roomContext.roomManager.join(connectionId, room),
              leave: (room: string | string[]) => roomContext.roomManager.leave(connectionId, room),
            }
          : { join: () => {}, leave: () => {} },
        eventSchemas,
      }

      if (roomContext) {
        roomContext.registerSession(session)
        sseReply.sse.onClose(() => {
          roomContext.unregisterSession(connectionId)
        })
      }

      if (options?.onConnect) {
        void Promise.resolve(options.onConnect(session)).catch(() => {})
      }

      if (options?.onClose) {
        const onClose = options.onClose
        sseReply.sse.onClose(() => {
          void Promise.resolve(onClose(session, 'client')).catch(() => {})
        })
      }

      if (options?.onReconnect && sseReply.sse.lastEventId) {
        const onReconnect = options.onReconnect
        const lastEventId = sseReply.sse.lastEventId
        void sseReply.sse.replay(async () => {
          const replay = await onReconnect(session, lastEventId)
          if (replay) {
            for await (const msg of replay) {
              await sseReply.sse.send(msg)
            }
          }
        })
      }

      return session
    },

    respond: ((code: number, body: unknown) => {
      if (started) {
        throw new Error(
          'Cannot call sse.respond() after sse.start() — the SSE stream is already open.',
        )
      }
      responseData = { code, body }
      return { _type: 'respond' as const, code, body }
      // biome-ignore lint/suspicious/noExplicitAny: respond typing is enforced by contract at call site
    }) as any,

    sendHeaders: () => {
      sseReply.sse.sendHeaders()
    },

    reply,
  }

  return {
    sseContext,
    isStarted: () => started,
    hasResponse: () => responseData !== undefined,
    getResponseData: () => responseData,
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Core SSE handler coordinates context, error handling, and lifecycle
async function handleApiSseRoute(
  // biome-ignore lint/suspicious/noExplicitAny: SSE handler types are validated by InferApiHandler at call site
  sseHandler: (request: any, sse: any) => unknown,
  eventSchemas: SseSchemaByEventName,
  options: ApiRouteOptions | undefined,
  // biome-ignore lint/suspicious/noExplicitAny: Request types are validated by Fastify schema
  request: any,
  reply: FastifyReply,
  roomContext?: ApiRouteInternalRoomContext,
): Promise<void> {
  const { sseContext, isStarted, hasResponse, getResponseData } = buildApiSSEContext(
    request,
    reply,
    eventSchemas,
    options,
    roomContext,
  )

  try {
    await sseHandler(request, sseContext)

    if (!isStarted() && !hasResponse()) {
      throw new Error(
        'SSE handler must either send a response (sse.respond()) ' +
          'or start streaming (sse.start()). Handler returned without doing either.',
      )
    }

    const responseData = getResponseData()
    if (responseData) {
      // Early HTTP response (sse.respond() was called before streaming)
      reply.removeHeader('cache-control')
      reply.removeHeader('x-accel-buffering')
      reply.type('application/json').code(responseData.code).send(responseData.body)
    }
    // If started, @fastify/sse manages the rest of the connection lifecycle
  } catch (err) {
    if (isStarted()) {
      // Headers already sent — can't change status code; try to send error event
      const sseReply = reply as SSEReply
      if (sseReply.sse.isConnected) {
        try {
          await sseReply.sse.send({
            event: 'error',
            data: { message: isErrorLike(err) ? err.message : 'Internal Server Error' },
          })
        } catch {
          // Ignore send failures during error handling
        }
      }
      throw err
    }

    // Streaming not started — send HTTP error response
    const message = isErrorLike(err) ? err.message : 'Internal Server Error'
    const statusCode = hasHttpStatusCode(err) ? err.httpStatusCode : 500
    const statusText = statusCode >= 500 ? 'Internal Server Error' : 'Error'
    reply.code(statusCode).type('application/json').send({ statusCode, error: statusText, message })
  }
}

// ============================================================================
// Internal Helpers — Schema
// ============================================================================

function buildBaseSchema(contract: ApiContract): Record<string, unknown> {
  const schema: Record<string, unknown> = {}
  if (contract.requestPathParamsSchema) schema.params = contract.requestPathParamsSchema
  if (contract.requestQuerySchema) schema.querystring = contract.requestQuerySchema
  if (contract.requestHeaderSchema) schema.headers = contract.requestHeaderSchema

  if (
    'requestBodySchema' in contract &&
    contract.requestBodySchema !== undefined &&
    contract.requestBodySchema !== ContractNoBody
  ) {
    schema.body = contract.requestBodySchema
  }

  return schema
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Create a typed handler container for an `ApiContract` route.
 *
 * The handler shape is inferred from the contract's response mode:
 * - `'non-sse'` → bare `async (request, reply) => body`
 * - `'sse'`     → bare `async (request, sse) => void`
 * - `'dual'`    → `{ nonSse, sse }` object, branched by `Accept` header
 *
 * @example Non-SSE route — bare function
 * ```typescript
 * const getUser = buildApiHandler(getUserContract,
 *   async (request) => ({ id: request.params.userId, name: 'Alice' }),
 * )
 * ```
 *
 * @example SSE-only route — bare function
 * ```typescript
 * const streamUpdates = buildApiHandler(updatesContract,
 *   async (request, sse) => {
 *     const session = sse.start('keepAlive')
 *     // session.send() writes directly to reply.sse — no controller involved
 *   },
 * )
 * ```
 *
 * @example Dual-mode route — `{ nonSse, sse }` object
 * ```typescript
 * const chatCompletion = buildApiHandler(chatContract, {
 *   nonSse: async (request) => ({ content: 'Hello' }),
 *   sse: async (request, sse) => {
 *     const session = sse.start('autoClose')
 *     await session.send('chunk', { delta: 'Hello' })
 *     await session.send('done', {})
 *   },
 * })
 * ```
 */
export function buildApiHandler<Contract extends ApiContract>(
  contract: Contract,
  handler: InferApiHandler<Contract>,
  options?: ApiRouteOptions,
): ApiRouteHandler<Contract> {
  return { __type: 'ApiRouteHandler' as const, contract, handler, options }
}

function buildApiRouteCore<Contract extends ApiContract>(
  routeHandler: ApiRouteHandler<Contract>,
  roomContext?: ApiRouteInternalRoomContext,
): RouteOptions {
  const { contract, handler, options } = routeHandler
  const url = mapApiContractToPath(contract)
  const mode = getContractResponseMode(contract)
  const eventSchemas = getSseSchemaByEventName(contract) ?? {}
  const baseSchema = buildBaseSchema(contract)
  const contractMetadata = options?.contractMetadataToRouteMapper?.(contract.metadata) ?? {}

  if (mode === 'non-sse') {
    // biome-ignore lint/suspicious/noExplicitAny: handler shape validated by InferApiHandler at call site
    const syncHandler = handler as any
    const routeOptions: RouteOptions = {
      ...contractMetadata,
      method: contract.method,
      url,
      schema: baseSchema,
      handler: async (request, reply) => handleApiSyncRoute(contract, syncHandler, request, reply),
    }
    if (options?.preHandler) routeOptions.preHandler = options.preHandler
    return routeOptions
  }

  if (mode === 'dual') {
    const defaultMode = options?.defaultMode ?? 'json'
    // biome-ignore lint/suspicious/noExplicitAny: handler shape validated by InferApiHandler at call site
    const dualHandlers = handler as any
    const routeOptions: RouteOptions = {
      ...contractMetadata,
      method: contract.method,
      url,
      sse: buildSSERouteConfig(options),
      schema: baseSchema,
      handler: (request, reply) => {
        const responseMode = determineMode(request.headers.accept, defaultMode)
        if (responseMode === 'json') {
          return handleApiSyncRoute(contract, dualHandlers.nonSse, request, reply)
        }
        return handleApiSseRoute(
          dualHandlers.sse,
          eventSchemas,
          options,
          request,
          reply,
          roomContext,
        )
      },
    }
    if (options?.preHandler) routeOptions.preHandler = options.preHandler
    return routeOptions
  }

  // SSE-only
  // biome-ignore lint/suspicious/noExplicitAny: handler shape validated by InferApiHandler at call site
  const sseHandler = handler as any
  const routeOptions: RouteOptions = {
    ...contractMetadata,
    method: contract.method,
    url,
    sse: buildSSERouteConfig(options),
    schema: baseSchema,
    handler: async (request, reply) =>
      handleApiSseRoute(sseHandler, eventSchemas, options, request, reply, roomContext),
  }
  if (options?.preHandler) routeOptions.preHandler = options.preHandler
  return routeOptions
}

/**
 * Build a Fastify `RouteOptions` object from an `ApiRouteHandler` container.
 *
 * SSE event sending goes directly through `reply.sse` — no controller required.
 *
 * @param routeHandler - Container returned by `buildApiHandler()`
 * @returns Fastify `RouteOptions` ready to pass to `app.route()`
 */
export function buildApiRoute<Contract extends ApiContract>(
  routeHandler: ApiRouteHandler<Contract>,
): RouteOptions {
  return buildApiRouteCore(routeHandler)
}

/**
 * Variant of `buildApiRoute` that wires real room operations into SSE sessions.
 * Called internally by `AbstractApiController.buildRoutes()` when rooms are enabled.
 * @internal
 */
export function _buildApiRouteWithRooms<Contract extends ApiContract>(
  routeHandler: ApiRouteHandler<Contract>,
  roomContext: ApiRouteInternalRoomContext,
): RouteOptions {
  return buildApiRouteCore(routeHandler, roomContext)
}
