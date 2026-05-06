import type { ApiContract } from '@lokalise/api-contracts'
import type { RouteOptions } from 'fastify'
import type { GatewayMetadataValue } from '../gateway/gatewayMetadata.ts'

/**
 * Abstract base class for controllers that use the `ApiContract` API.
 *
 * Concrete controllers declare a static `contracts` field and a `routes` object
 * built with `buildApiRoute()`. The generic ensures every contract has a matching route.
 *
 * @example
 * ```typescript
 * class UserController extends AbstractApiController<typeof UserController.contracts> {
 *   static contracts = {
 *     getUser: getUserContract,
 *     streamUpdates: streamUpdatesContract,
 *   } as const
 *
 *   readonly routes = {
 *     getUser: buildApiRoute(UserController.contracts.getUser, async (req) => ({
 *       status: 200,
 *       body: { id: req.params.id },
 *     })),
 *     streamUpdates: buildApiRoute(UserController.contracts.streamUpdates, async (_req, sse) => {
 *       sse.start('keepAlive')
 *     }),
 *   }
 * }
 * ```
 */
export abstract class AbstractApiController<APIContracts extends Record<string, ApiContract>> {
  abstract readonly routes: Record<keyof APIContracts, RouteOptions>

  /**
   * Optional controller-level defaults for gateway metadata.
   *
   * Merged underneath per-route metadata (attached via `withGatewayMetadata`)
   * when `DIContext.buildGatewayManifest()` assembles a manifest. See
   * `AbstractController.gatewayDefaults` for full semantics.
   */
  public readonly gatewayDefaults?: GatewayMetadataValue
}
