import type {
  ApiContract,
  ContractNoBody,
  ContractResponseMode,
  InferNonSseSuccessResponses,
  InferSseSuccessResponses,
  PayloadApiContract,
} from '@lokalise/api-contracts'
import type { FastifyRequest } from 'fastify'
import type { z } from 'zod/v4'
import type { DualModeType } from '../dualmode/dualModeTypes.ts'
import type {
  FastifySSERouteOptions,
  SSEContext,
  SSEHandlerResult,
  SyncModeReply,
} from '../routes/fastifyRouteTypes.ts'

// ============================================================================
// Request Inference
// ============================================================================

type InferOptSchema<T, Fallback = unknown> =
  NonNullable<T> extends z.ZodType ? z.output<NonNullable<T>> : Fallback

type InferApiBodyType<Contract extends ApiContract> = Contract extends PayloadApiContract
  ? Contract['requestBodySchema'] extends typeof ContractNoBody
    ? undefined
    : NonNullable<Contract['requestBodySchema']> extends z.ZodType
      ? z.output<NonNullable<Contract['requestBodySchema']>>
      : undefined
  : undefined

/**
 * Infer the FastifyRequest type from an ApiContract.
 *
 * Provides properly typed params, querystring, headers, and body.
 *
 * @example
 * ```typescript
 * const handler = async (request: InferApiRequest<typeof myContract>) => {
 *   request.params.userId  // typed
 *   request.body.name      // typed
 * }
 * ```
 */
export type InferApiRequest<Contract extends ApiContract> = FastifyRequest<{
  Params: InferOptSchema<Contract['requestPathParamsSchema']>
  Querystring: InferOptSchema<Contract['requestQuerySchema']>
  Headers: InferOptSchema<Contract['requestHeaderSchema']>
  Body: InferApiBodyType<Contract>
}>

// ============================================================================
// Handler Types
// ============================================================================

/**
 * Handler for non-SSE responses from an ApiContract.
 *
 * Return the response body directly — the framework validates it against the
 * contract's JSON success schemas and sends it. Use `reply.code()` to set
 * non-200 status codes, but do not call `reply.send()`.
 */
export type ApiNonSseHandler<Contract extends ApiContract> = (
  request: InferApiRequest<Contract>,
  reply: SyncModeReply,
) =>
  | InferNonSseSuccessResponses<Contract['responsesByStatusCode']>
  | Promise<InferNonSseSuccessResponses<Contract['responsesByStatusCode']>>

/**
 * Handler for SSE responses from an ApiContract.
 *
 * Call `sse.start(mode)` to begin streaming or `sse.respond(code, body)` for
 * early HTTP returns before streaming starts.
 */
export type ApiSseHandler<Contract extends ApiContract> = (
  request: InferApiRequest<Contract>,
  sse: SSEContext<InferSseSuccessResponses<Contract['responsesByStatusCode']>>,
) => SSEHandlerResult | Promise<SSEHandlerResult>

/**
 * Infer the handler shape based on the contract's response mode:
 * - `'non-sse'` — bare `ApiNonSseHandler` function
 * - `'sse'`     — bare `ApiSseHandler` function
 * - `'dual'`    — `{ nonSse, sse }` object, branched by `Accept` header
 */
export type InferApiHandler<Contract extends ApiContract> = [
  ContractResponseMode<Contract['responsesByStatusCode']>,
] extends ['dual']
  ? { nonSse: ApiNonSseHandler<Contract>; sse: ApiSseHandler<Contract> }
  : [ContractResponseMode<Contract['responsesByStatusCode']>] extends ['sse']
    ? ApiSseHandler<Contract>
    : ApiNonSseHandler<Contract>

// ============================================================================
// Route Options
// ============================================================================

/**
 * Options for configuring an ApiContract route.
 *
 * SSE lifecycle options (`onConnect`, `onClose`, `onReconnect`) are only
 * relevant for SSE and dual-mode contracts and are ignored for non-SSE routes.
 */
export type ApiRouteOptions = FastifySSERouteOptions & {
  /**
   * Default response mode for dual-mode routes when the `Accept` header
   * does not express a preference.
   * @default 'json'
   */
  defaultMode?: DualModeType
}

// ============================================================================
// Route Handler Container
// ============================================================================

/**
 * Branded container returned by `buildApiHandler()`.
 *
 * Carries the contract, handler functions, and optional route options in a
 * single value so they can be passed as a unit to `buildApiRoute()`.
 */
export type ApiRouteHandler<Contract extends ApiContract> = {
  readonly __type: 'ApiRouteHandler'
  readonly contract: Contract
  readonly handler: InferApiHandler<Contract>
  readonly options?: ApiRouteOptions
}

/**
 * Return type for `AbstractApiController.buildApiRoutes()`.
 *
 * Maps route keys to their `ApiRouteHandler` containers.
 */
export type BuildApiRoutesReturnType<Contracts extends Record<string, ApiContract>> = {
  [K in keyof Contracts]: ApiRouteHandler<Contracts[K]>
}
