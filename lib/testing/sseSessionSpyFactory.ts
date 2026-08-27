import type {
  SSESession as ApiSSESession,
  SSECloseInitiator,
} from '@lokalise/fastify-api-contracts'
import { type SpiedSSESession, SSESessionSpy } from '../sse/SSESessionSpy.ts'

/**
 * The SSE lifecycle hooks that feed a standalone {@link SSESessionSpy}.
 *
 * Shaped to be spread straight into route options that accept SSE lifecycle
 * hooks — `buildApiRoute` / `buildFastifyApiRoute` options, or this package's
 * own `buildFastifyRoute` options.
 */
export type SSESessionSpyRouteOptions<TSession extends SpiedSSESession = ApiSSESession> = {
  onConnect: (connection: TSession) => void
  onClose: (connection: TSession, initiator: SSECloseInitiator) => void
}

/**
 * Result of {@link createSSESessionSpy}.
 */
export type CreateSSESessionSpyResult<TSession extends SpiedSSESession = ApiSSESession> = {
  /** The spy, ready to hand to `SSEHttpClient.connect`'s `awaitServerConnection`. */
  spy: SSESessionSpy<TSession>
  /** `{ onConnect, onClose }` to spread into the route's options. */
  routeOptions: SSESessionSpyRouteOptions<TSession>
}

/**
 * Create a standalone connection spy plus the route hooks that drive it.
 *
 * `AbstractSSEController` exposes a spy of its own via `connectionSpy` (gated on
 * `{ enableConnectionSpy: true }`). Services built on `AbstractApiController` +
 * `buildApiRoute` have no such controller, so this factory provides the same
 * capability by attaching to the route's `onConnect` / `onClose` hooks. That
 * removes the race between `connect()` returning (HTTP headers received) and the
 * server-side handler finishing its connection registration.
 *
 * The spy observes `@lokalise/fastify-api-contracts` sessions by default, which
 * is what `buildApiRoute` hands to its hooks. Pass this package's `SSESession`
 * as the type argument when wiring it to `buildFastifyRoute` instead.
 *
 * @example
 * ```typescript
 * const { spy, routeOptions } = createSSESessionSpy()
 *
 * // in the app-under-test's route registration
 * app.route(buildApiRoute(contract, handler, { ...routeOptions }))
 *
 * // in the test
 * const { client, serverConnection } = await SSEHttpClient.connect(baseUrl, path, {
 *   awaitServerConnection: { spy },
 * })
 * // serverConnection is registered server-side and ready to use
 * ```
 */
export function createSSESessionSpy<
  TSession extends SpiedSSESession = ApiSSESession,
>(): CreateSSESessionSpyResult<TSession> {
  const spy = new SSESessionSpy<TSession>()

  return {
    spy,
    routeOptions: {
      onConnect: (connection) => spy.addConnection(connection),
      onClose: (connection) => spy.addDisconnection(connection.id),
    },
  }
}
