import type {
  ApiContract,
  ContractNoBody,
  ContractResponseMode,
  InferSseSuccessResponses,
  PayloadApiContract,
  SSEEventSchemas,
} from '@lokalise/api-contracts'
import type { FastifyRequest, RouteOptions } from 'fastify'
import type { z } from 'zod/v4'
import type { DualModeType } from '../dualmode/dualModeTypes.ts'
import type { GatewayMetadata } from '../gateway/gatewayTypes.ts'
import type {
  FastifySSERouteOptions,
  SSEContext,
  SSEHandlerResult,
  SyncModeReply,
} from '../routes/fastifyRouteTypes.ts'

// ============================================================================
// Status+Body Response
// ============================================================================

type NonSseBodyDescriptor<D> = D extends { _tag: 'SseBody' }
  ? never
  : D extends { _tag: 'BlobBody' }
    ? Blob
    : D extends z.ZodType
      ? z.output<D>
      : never

type NonSseBodyEntry<T> = T extends undefined
  ? never
  : T extends { content: infer TContent }
    ?
        | NonSseBodyDescriptor<TContent[keyof TContent]>
        | (T extends { allowNoBody: true } ? undefined : never)
    : T extends { allowNoBody: true }
      ? undefined
      : T extends z.ZodType
        ? z.output<T>
        : undefined

/**
 * Discriminated union of `{ status, body }` pairs for all non-SSE responses in a contract.
 *
 * Allows non-SSE handlers to return a specific status code and body together without
 * calling `reply.code()` separately.
 *
 * @example
 * ```typescript
 * async (request) => {
 *   if (!valid) return { status: 400, body: { error: 'Bad Request' } }
 *   return { id: request.params.id }
 * }
 * ```
 */
export type InferApiStatusResponse<Contract extends ApiContract> = {
  [K in keyof Contract['responsesByStatusCode']]: NonSseBodyEntry<
    Contract['responsesByStatusCode'][K]
  > extends never
    ? never
    : { status: K; body: NonSseBodyEntry<Contract['responsesByStatusCode'][K]> }
}[keyof Contract['responsesByStatusCode']]

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
 * Always return `{ status, body }` — the framework validates the body against the
 * contract's schema for that status code and sends it.
 *
 * Use `reply.header()` to set response headers when needed.
 *
 * @example
 * ```typescript
 * async (request) => ({ status: 200, body: { id: request.params.userId } })
 * ```
 *
 * @example With multiple status codes
 * ```typescript
 * async (request) => {
 *   if (!valid) return { status: 400, body: { error: 'Bad Request' } }
 *   return { status: 200, body: { id: request.params.userId } }
 * }
 * ```
 */
export type ApiNonSseHandler<Contract extends ApiContract> = (
  request: InferApiRequest<Contract>,
  reply: SyncModeReply,
) => InferApiStatusResponse<Contract> | Promise<InferApiStatusResponse<Contract>>

/**
 * Handler for SSE responses from an ApiContract.
 *
 * Call `sse.start(mode)` to begin streaming or `sse.respond(code, body)` for
 * early HTTP returns before streaming starts.
 */
export type ApiSseHandler<Contract extends ApiContract> = (
  request: InferApiRequest<Contract>,
  sse: SSEContext<
    EnsureSseEventSchemas<InferSseSuccessResponses<Contract['responsesByStatusCode']>>
  >,
) => SSEHandlerResult | Promise<SSEHandlerResult>

/**
 * `InferSseSuccessResponses` resolves to the contract's SSE event schema map, but for a
 * generic `Contract` the content-map response path can widen it beyond `SSEEventSchemas`.
 * This narrows it back so it satisfies the `SSEContext` constraint, falling back to the
 * base `SSEEventSchemas` when the inferred type is not a valid schema map.
 */
export type EnsureSseEventSchemas<TEvents> = [TEvents] extends [SSEEventSchemas]
  ? TEvents
  : SSEEventSchemas

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
 * Extends Fastify's `RouteOptions` minus the fields the contract provides
 * (`method`, `url`, `schema`, `handler`, `sse`), so any Fastify hook or config
 * (`preHandler`, `onRequest`, `config`, `bodyLimit`, etc.) can be passed directly.
 *
 * SSE lifecycle options (`onConnect`, `onClose`, `onReconnect`) are only
 * relevant for SSE and dual-mode contracts and are ignored for non-SSE routes.
 *
 * Generic in `Contract` so `gatewayMetadata.match.headers` / `match.query`
 * keys are narrowed to the contract's request schemas. The generic is always
 * inferred from the contract argument at the `buildApiRoute` call site, so
 * direct references should write `ApiRouteOptions<typeof myContract>` when
 * gateway metadata typing is needed.
 */
export type ApiRouteOptions<Contract extends ApiContract> = Omit<
  RouteOptions,
  'method' | 'url' | 'schema' | 'handler' | 'sse'
> &
  Omit<FastifySSERouteOptions, 'preHandler'> & {
    /**
     * Default response mode for dual-mode routes when the `Accept` header
     * does not express a preference.
     * @default 'json'
     */
    defaultMode?: DualModeType
    /**
     * Per-route gateway metadata. `match.headers` / `match.query` keys are
     * narrowed to the contract's request schemas; `customHeaders` /
     * `customQuery` remain the escape hatch for headers and params not
     * declared on the contract. Validated at runtime against the same Zod
     * schema used by `withGatewayMetadata` and stamped on the route via the
     * shared `GATEWAY_METADATA_SYMBOL`.
     *
     * Equivalent to wrapping the result with `withGatewayMetadata` — keep
     * to one form per route. If both are used on the same route, the later
     * call (typically `withGatewayMetadata`) overwrites the inline value;
     * there is no merge.
     *
     * @example
     * ```ts
     * buildApiRoute(MyController.contracts.getItem, this.getItem, {
     *   gatewayMetadata: {
     *     cache: { ttl: '60s' },
     *     match: {
     *       // narrowed to keys of the contract's requestHeaderSchema:
     *       headers: { 'x-trace-id': { regex: '^[a-f0-9]+$' } },
     *       // escape hatch for headers not declared on the contract:
     *       customHeaders: { 'x-tenant-id': { regex: '^t_' } },
     *     },
     *   },
     * })
     * ```
     */
    gatewayMetadata?: GatewayMetadata<Contract>
  }
