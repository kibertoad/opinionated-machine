import type { ApiContract } from '@lokalise/api-contracts'
import { type GatewayMetadataValue, gatewayMetadataSchema } from './gatewayMetadata.ts'
import { GATEWAY_METADATA_SYMBOL } from './gatewaySymbol.ts'
import type { GatewayMetadata } from './gatewayTypes.ts'

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
 *
 * Parameter is `unknown` because the contract-narrowed `GatewayMetadata<C>`
 * shapes from the two call sites aren't structurally assignable to each
 * other (variant `ContractRateLimitKey<C>`), and the runtime Zod schema is
 * the actual source of truth either way.
 */
export function attachGatewayMetadata<Route extends object>(
  route: Route,
  metadata: unknown,
): Route {
  // Validate eagerly so a bad shape fails at the call site (with a clean
  // Zod issue path) rather than later when DIContext.buildGatewayManifest
  // walks every route at once.
  const validated = gatewayMetadataSchema.parse(metadata)
  Object.defineProperty(route, GATEWAY_METADATA_SYMBOL, {
    value: validated,
    enumerable: false,
    configurable: true,
    writable: true,
  })
  return route
}

/**
 * Attach gateway metadata to a route built by `buildApiRoute`.
 *
 * The metadata is stamped on the route via a non-enumerable `Symbol` property,
 * so Fastify never sees it (it walks own enumerable keys when registering
 * routes). The same route reference is returned — no copy, no spread.
 *
 * Apply in the controller's `routes` object so all gateway annotations for a
 * controller live in a single, scannable block:
 *
 * @example
 * ```ts
 * readonly routes = {
 *   getItem: withGatewayMetadata(
 *     MyController.contracts.getItem,
 *     buildApiRoute(MyController.contracts.getItem, this.getItem),
 *     {
 *       cache: { ttl: '60s' },
 *       match: { customHeaders: { 'x-tenant-id': { regex: '^t_' } } },
 *     },
 *   ),
 *   // un-annotated routes pass through directly — they still inherit
 *   // controller- and service-wide gateway defaults.
 *   deleteItem: buildApiRoute(MyController.contracts.deleteItem, this.deleteItem),
 * }
 * ```
 *
 * `buildApiRoute(..., { gatewayMetadata })` is the simpler inline path; this
 * helper remains the right tool when the route is constructed elsewhere.
 *
 * @param _contract - The contract is taken purely to drive type inference for
 *   `match.headers`, `match.query`, and `rateLimit.key`. It is not stored.
 * @param route - The route returned by `buildApiRoute`.
 * @param metadata - Per-route gateway metadata.
 * @returns The same `route` reference, with metadata attached via Symbol.
 */
export function withGatewayMetadata<Contract extends ApiContract, Route extends object>(
  _contract: Contract,
  route: Route,
  metadata: GatewayMetadata<Contract>,
): Route {
  return attachGatewayMetadata(route, metadata)
}

/**
 * Read gateway metadata previously stamped on a route — either by
 * `withGatewayMetadata`, by `buildApiRoute(..., { gatewayMetadata })`, or by
 * the shared `attachGatewayMetadata` helper. Returns `undefined` if no
 * metadata was attached.
 */
export function readGatewayMetadata(route: object): GatewayMetadataValue | undefined {
  return (route as Record<symbol, GatewayMetadataValue | undefined>)[GATEWAY_METADATA_SYMBOL]
}
