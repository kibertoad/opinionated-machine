import type { ApiContract, ApiContractResponse, ResponseEntry } from '@lokalise/api-contracts'
import {
  getSseSchemaByEventName,
  hasAnySuccessSseResponse,
  isContentResponseEntry,
  isSseBody,
  type SSEEventSchemas,
  SUCCESSFUL_HTTP_STATUS_CODES,
} from '@lokalise/api-contracts'
import {
  buildFastifyApiRoute,
  type ApiRouteOptions as FastifyApiRouteOptions,
  type InferApiHandler,
} from '@lokalise/fastify-api-contracts'
import type { RouteOptions } from 'fastify'
import type { GatewayMetadata } from '../gateway/gatewayTypes.ts'
import { attachRouteStreamingMode, type RouteStreamingMode } from '../gateway/routeStreaming.ts'
import { attachGatewayMetadata } from '../gateway/withGatewayMetadata.ts'
import type { SSERoomBroadcaster } from '../sse/rooms/SSERoomBroadcaster.ts'
import { attachSSESendDiagnostics, reportSSEHandlerOutcome } from '../sse/sseSendDiagnostics.ts'
import { type SSERoomsOptions, withSessionRooms } from './apiSseConnectionRegistry.ts'

/**
 * Options for configuring an ApiContract route.
 *
 * All options from `@lokalise/fastify-api-contracts` (any Fastify route field
 * minus the ones the contract provides, SSE lifecycle hooks, and
 * `contractMetadataToRouteMapper`) pass through to `buildFastifyApiRoute`
 * unchanged.
 *
 * Generic in `Contract` so `gatewayMetadata.match.headers` / `match.query`
 * keys are narrowed to the contract's request schemas. The generic is always
 * inferred from the contract argument at the `buildApiRoute` call site, so
 * direct references should write `ApiRouteOptions<typeof myContract>` when
 * gateway metadata typing is needed.
 */
export type ApiRouteOptions<Contract extends ApiContract> = FastifyApiRouteOptions & {
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
  /**
   * Enable SSE rooms for this route by passing the shared `SSERoomBroadcaster`
   * from the DI container. Sessions opened by the route's SSE handler are
   * registered with the broadcaster (so `broadcastToRoom`/`broadcastMessage`
   * reach them), get room operations via {@link getSessionRooms}, and are
   * cleaned up (rooms left, dedup cache cleared) when the connection closes.
   *
   * Without this option `getSessionRooms()` returns no-ops and the session
   * receives no room broadcasts.
   *
   * Pass an {@link SSERoomsOptions} object instead of the bare broadcaster to
   * declare an `authorizeJoin` scope check (so a room name built from a path
   * param cannot leak across tenants) and a `maxSessionLifetimeMs` bound (so
   * authorization checked at connect cannot stay in force forever).
   *
   * @example
   * ```ts
   * buildApiRoute(contracts.watchProject, this.watch, { sseRooms: this.roomBroadcaster })
   * // inside the handler:
   * const session = sse.start('keepAlive')
   * getSessionRooms(session).join(`project:${request.params.projectId}`)
   * ```
   *
   * @example
   * ```ts
   * buildApiRoute(contracts.watchProject, this.watch, {
   *   sseRooms: {
   *     broadcaster: this.roomBroadcaster,
   *     authorizeJoin: (session, room) =>
   *       this.membership.canRead(session.request.user, room),
   *     maxSessionLifetimeMs: 30 * 60 * 1000,
   *   },
   * })
   * ```
   */
  sseRooms?: SSERoomBroadcaster | SSERoomsOptions
}

/**
 * True when the contract's success response for a status code has a non-SSE
 * representation as well — i.e. the route can answer a plain HTTP request.
 */
function isSuccessResponseDual(value: ApiContractResponse | ResponseEntry): boolean {
  if (isContentResponseEntry(value)) {
    // A content-map entry offers a non-SSE representation when it allows an empty
    // body or declares any non-SSE media type descriptor.
    if (value.allowNoBody || !value.content) return true
    return Object.values(value.content).some((descriptor) => !isSseBody(descriptor))
  }
  // A bare Zod schema is a JSON response, which always has a non-SSE representation.
  return true
}

/**
 * Derive how a contract streams, for the gateway streaming marker.
 *
 * Mirrors `ContractResponseMode` from `@lokalise/api-contracts` at runtime:
 * a contract with no SSE success response is plain, one whose SSE statuses all
 * lack a non-SSE representation is `'sse'`, and one that offers both is `'dual'`.
 */
function getContractStreamingMode(contract: ApiContract): RouteStreamingMode | undefined {
  if (!hasAnySuccessSseResponse(contract)) return undefined
  for (const code of SUCCESSFUL_HTTP_STATUS_CODES) {
    const value = contract.responsesByStatusCode[code]
    if (value && isSuccessResponseDual(value)) return 'dual'
  }
  return 'sse'
}

/**
 * Build a Fastify `RouteOptions` object from an `ApiContract` + handler.
 *
 * Thin wrapper around `buildFastifyApiRoute` from
 * `@lokalise/fastify-api-contracts` — the handler shape, response mode
 * inference, SSE streaming, and validation semantics are all the package's.
 * See its docs for the `(request, reply, context) => { status, body }`
 * handler model and `context.sse` streaming.
 *
 * On top of the package builder this adds:
 * - `gatewayMetadata` — per-route gateway policy with header / query keys
 *   narrowed to the contract; equivalent to wrapping the result with
 *   `withGatewayMetadata`. See `ApiRouteOptions` for full details.
 * - `sseRooms` — wires SSE rooms for the route (see `ApiRouteOptions`).
 * - a `streaming: 'sse' | 'dual'` marker on SSE-capable routes, read back by
 *   the gateway manifest builder so generators can apply streaming-appropriate
 *   timeouts and buffering.
 *
 * @returns Fastify `RouteOptions` ready to pass to `app.route()`
 */
export function buildApiRoute<Contract extends ApiContract>(
  contract: Contract,
  handler: InferApiHandler<Contract>,
  options?: ApiRouteOptions<Contract>,
): RouteOptions {
  // Gateway metadata is stamped via Symbol, not spread into Fastify options;
  // `sseRooms` is framework-level and composed into the SSE lifecycle hooks.
  const { gatewayMetadata, sseRooms, ...passthroughOptions } = options ?? {}
  const fastifyOptions = sseRooms
    ? withSessionRooms(sseRooms, passthroughOptions)
    : passthroughOptions

  const schemaByEventName = getSseSchemaByEventName(contract)
  const built = buildFastifyApiRoute(
    contract,
    handler,
    schemaByEventName ? withSendDiagnostics(fastifyOptions, schemaByEventName) : fastifyOptions,
  )
  // Recording a failed send is only half of the diagnostic: whether the route recovered from
  // it decides whether a test reading the stream should fail on it. That is what the handler's
  // own outcome says, so it is observed here, for scoped requests only.
  const route = schemaByEventName
    ? { ...built, handler: reportSSEHandlerOutcome(built.handler) }
    : built

  // Mark streaming routes (derived from the contract's response mode) so
  // gateway generators can apply streaming-appropriate timeouts/buffering.
  // After the spread above: it drops the non-enumerable symbol the stamp sets.
  const streamingMode = getContractStreamingMode(contract)
  if (streamingMode) {
    attachRouteStreamingMode(route, streamingMode)
  }

  return gatewayMetadata !== undefined ? attachGatewayMetadata(route, gatewayMetadata) : route
}

/**
 * Instrument the sessions of an SSE route so a send the handler could not make is reported to
 * the test that is reading the stream, instead of only to the server log.
 *
 * A payload that fails the contract's schema for its event makes `session.send()` throw from
 * inside the handler: the event never reaches the wire, the stream just ends early, and the
 * test sees a missing event with no reason attached. The SSE test helpers (`injectApiSSE`,
 * `connectApiSSE`) tag their requests with a diagnostics header and surface what was recorded
 * for them.
 *
 * Costs nothing outside a test run: the hook is only added for contracts that declare SSE
 * events, and it does nothing unless the request names a diagnostics scope open in this
 * process — something only those helpers produce.
 */
function withSendDiagnostics(
  options: FastifyApiRouteOptions,
  schemaByEventName: SSEEventSchemas,
): FastifyApiRouteOptions {
  const { onConnect } = options
  return {
    ...options,
    // Called synchronously by `sse.start()` before the session reaches the handler, so the
    // instrumentation is in place before the handler's first send.
    onConnect: (session) => {
      attachSSESendDiagnostics(session, schemaByEventName)
      return onConnect?.(session)
    },
  }
}
