import type { ApiContract } from '@lokalise/api-contracts'
import {
  buildFastifyApiRoute,
  type ApiRouteOptions as FastifyApiRouteOptions,
  type InferApiHandler,
} from '@lokalise/fastify-api-contracts'
import type { RouteOptions } from 'fastify'
import type { GatewayMetadata } from '../gateway/gatewayTypes.ts'
import { attachGatewayMetadata } from '../gateway/withGatewayMetadata.ts'

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
 * On top of the package builder this adds one option: `gatewayMetadata` —
 * per-route gateway policy with header / query keys narrowed to the
 * contract; equivalent to wrapping the result with `withGatewayMetadata`.
 * See `ApiRouteOptions` for full details.
 *
 * @returns Fastify `RouteOptions` ready to pass to `app.route()`
 */
export function buildApiRoute<Contract extends ApiContract>(
  contract: Contract,
  handler: InferApiHandler<Contract>,
  options?: ApiRouteOptions<Contract>,
): RouteOptions {
  // Gateway metadata is stamped via Symbol, not spread into Fastify options.
  const { gatewayMetadata, ...fastifyOptions } = options ?? {}
  const route = buildFastifyApiRoute(contract, handler, fastifyOptions)
  return gatewayMetadata !== undefined ? attachGatewayMetadata(route, gatewayMetadata) : route
}
