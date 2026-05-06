import type { CommonRouteDefinition } from '@lokalise/api-contracts'
import { type GatewayMetadataValue, gatewayMetadataSchema } from './gatewayMetadata.ts'
import { GATEWAY_METADATA_SYMBOL } from './gatewaySymbol.ts'
import type { GatewayMetadata } from './gatewayTypes.ts'

// biome-ignore lint/suspicious/noExplicitAny: shape-agnostic — we don't constrain contract generics here
type AnyContract = CommonRouteDefinition<any, any, any, any, any, any, any, any>

/**
 * Validate gateway metadata and stamp it onto a route via the
 * `GATEWAY_METADATA_SYMBOL` non-enumerable property.
 *
 * Shared between `withGatewayMetadata` (the post-hoc helper) and
 * `buildApiRoute` (which accepts `gatewayMetadata` inline via its options).
 * Centralising the validate-and-stamp logic here keeps both authoring styles
 * behaviourally identical: same Zod errors at the call site, same hidden
 * symbol storage, same value visible to `readGatewayMetadata` and
 * `buildGatewayManifest`.
 */
export function attachGatewayMetadata<Route extends object>(
  route: Route,
  metadata: GatewayMetadata<unknown>,
): Route {
  const validated = gatewayMetadataSchema.parse(metadata) as GatewayMetadataValue
  Object.defineProperty(route, GATEWAY_METADATA_SYMBOL, {
    value: validated,
    enumerable: false,
    configurable: true,
    writable: true,
  })
  return route
}

/**
 * Attach gateway metadata to a route built by `buildFastifyRoute` / `buildApiRoute`.
 *
 * The metadata is stamped on the route via a non-enumerable `Symbol` property,
 * so Fastify never sees it (it walks own enumerable keys when registering
 * routes). The same route reference is returned — no copy, no spread.
 *
 * Apply at the `buildRoutes()` return site (or in the `routes` object for
 * `AbstractApiController`) so all gateway annotations for a controller live in
 * a single, scannable block:
 *
 * @example
 * ```ts
 * public buildRoutes(): BuildRoutesReturnType<typeof MyController.contracts> {
 *   return {
 *     getItem: withGatewayMetadata(MyController.contracts.getItem, this.getItem, {
 *       cache: { ttl: '60s' },
 *       match: { customHeaders: { 'x-tenant-id': { regex: '^t_' } } },
 *     }),
 *     // un-annotated routes pass through directly — they still inherit
 *     // controller- and service-wide gateway defaults.
 *     deleteItem: this.deleteItem,
 *   }
 * }
 * ```
 *
 * For `buildApiRoute`-built routes, `options.gatewayMetadata` is the simpler
 * inline path; this helper remains the right tool for routes built with
 * `buildFastifyRoute` and for cases where the route is constructed elsewhere.
 *
 * @param _contract - The contract is taken purely to drive type inference for
 *   `match.headers`, `match.query`, and `rateLimit.key`. It is not stored.
 * @param route - The route returned by `buildFastifyRoute` or `buildApiRoute`.
 * @param metadata - Per-route gateway metadata.
 * @returns The same `route` reference, with metadata attached via Symbol.
 */
export function withGatewayMetadata<Contract extends AnyContract, Route extends object>(
  _contract: Contract,
  route: Route,
  metadata: GatewayMetadata<Contract>,
): Route {
  return attachGatewayMetadata(route, metadata as GatewayMetadata<unknown>)
}

/**
 * Read gateway metadata previously stamped on a route by `withGatewayMetadata`.
 * Returns `undefined` if no metadata was attached.
 */
export function readGatewayMetadata(route: object): GatewayMetadataValue | undefined {
  return (route as Record<symbol, GatewayMetadataValue | undefined>)[GATEWAY_METADATA_SYMBOL]
}
