import type { RouteOptions } from 'fastify'

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
}
