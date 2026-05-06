import type { RouteOptions } from 'fastify'
import type { GatewayMetadataValue } from '../gateway/gatewayMetadata.ts'

/**
 * Abstract base class for controllers that use the `ApiContract` API.
 *
 * Concrete controllers declare a `routes` property built with `buildApiRoute()`.
 *
 * @example
 * ```typescript
 * class UserController extends AbstractApiController {
 *   readonly routes = [
 *     buildApiRoute(getUser, async (req) => ({ status: 200, body: { id: req.params.id } })),
 *     buildApiRoute(streamUpdates, async (_req, sse) => { sse.start('keepAlive') }),
 *   ]
 * }
 * ```
 */
export abstract class AbstractApiController {
  abstract readonly routes: RouteOptions[]

  /**
   * Optional controller-level defaults for gateway metadata.
   *
   * Merged underneath per-route metadata (attached via `withGatewayMetadata`)
   * when `DIContext.buildGatewayManifest()` assembles a manifest. See
   * `AbstractController.gatewayDefaults` for full semantics.
   */
  public readonly gatewayDefaults?: GatewayMetadataValue
}
