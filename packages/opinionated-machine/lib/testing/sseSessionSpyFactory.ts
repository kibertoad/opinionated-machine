import type {
  SSESession as ApiSSESession,
  SSECloseInitiator,
} from '@lokalise/fastify-api-contracts'
import { type SpiedSSESession, SSESessionSpy } from '../sse/SSESessionSpy.ts'

/**
 * The SSE lifecycle hooks a route may declare, as far as a spy is concerned.
 *
 * Structurally a subset of the SSE route options of both `buildApiRoute` /
 * `buildFastifyApiRoute` and this package's own `buildFastifyRoute`, so any of
 * their option objects can be handed to {@link CreateSSESessionSpyResult.withSpy}.
 */
export type SSESessionSpyHooks<TSession extends SpiedSSESession = ApiSSESession> = {
  onConnect?: (connection: TSession) => void | Promise<void>
  onClose?: (connection: TSession, initiator: SSECloseInitiator) => void | Promise<void>
}

/**
 * The SSE lifecycle hooks that feed a standalone {@link SSESessionSpy}.
 *
 * Shaped to be spread straight into route options that accept SSE lifecycle
 * hooks — `buildApiRoute` / `buildFastifyApiRoute` options, or this package's
 * own `buildFastifyRoute` options.
 *
 * Spreading these over options that declare `onConnect` / `onClose` of their own
 * would silently drop one side or the other; use
 * {@link CreateSSESessionSpyResult.withSpy} for such routes, which chains both.
 */
export type SSESessionSpyRouteOptions<TSession extends SpiedSSESession = ApiSSESession> = {
  onConnect: (connection: TSession) => void | Promise<void>
  onClose: (connection: TSession, initiator: SSECloseInitiator) => void | Promise<void>
}

/**
 * Result of {@link createSSESessionSpy}.
 */
export type CreateSSESessionSpyResult<TSession extends SpiedSSESession = ApiSSESession> = {
  /** The spy, ready to hand to `SSEHttpClient.connect`'s `awaitServerConnection`. */
  spy: SSESessionSpy<TSession>
  /**
   * `{ onConnect, onClose }` to spread into the options of a route that declares
   * no SSE lifecycle hooks of its own. Equivalent to `withSpy()`.
   */
  routeOptions: SSESessionSpyRouteOptions<TSession>
  /**
   * Merge the spy's hooks into a route's own options.
   *
   * Any `onConnect` / `onClose` the route already declares is kept and runs
   * first; the spy is notified once that hook settles. Every other option is
   * passed through untouched. Use this instead of spreading
   * {@link CreateSSESessionSpyResult.routeOptions}, which would replace the
   * route's hooks rather than compose with them.
   *
   * @example
   * ```typescript
   * app.route(
   *   buildApiRoute(contract, handler, withSpy({
   *     heartbeat: false,
   *     onConnect: (connection) => subscriptions.add(connection.id),
   *   })),
   * )
   * ```
   */
  withSpy: <TOptions extends object>(
    options?: TOptions & SSESessionSpyHooks<TSession>,
  ) => Omit<TOptions, 'onConnect' | 'onClose'> & SSESessionSpyRouteOptions<TSession>
}

const isThenable = (value: unknown): value is Promise<unknown> =>
  typeof (value as { then?: unknown } | undefined)?.then === 'function'

/**
 * Run a route's own lifecycle hook, then notify the spy — even if the hook fails.
 *
 * The spy is an observer of the connection, not a participant in it: a hook that
 * throws is a failure of the app under test, and swallowing the connection event
 * on top of it would surface as an unrelated `waitForConnection` timeout much
 * later. The hook's own failure is propagated to the route builder unchanged.
 *
 * The spy is notified *after* the hook, mirroring `AbstractSSEController`, so a
 * hook that enriches the session does so before any waiter observes it.
 */
function runHookThenNotify(
  hook: () => void | Promise<void>,
  notify: () => void,
): void | Promise<void> {
  let result: void | Promise<void>
  try {
    result = hook()
  } catch (error) {
    notify()
    throw error
  }

  if (isThenable(result)) {
    return result.then(
      () => notify(),
      (error: unknown) => {
        notify()
        throw error
      },
    )
  }

  notify()
}

/**
 * Create a standalone connection spy plus the route hooks that drive it.
 *
 * `AbstractSSEController` exposes a spy of its own via `connectionSpy` (gated on
 * `{ enableConnectionSpy: true }`). Routes built with `buildApiRoute` have no
 * such controller, so this factory drives a spy from the route's `onConnect` /
 * `onClose` hooks instead. That removes the race between `connect()` returning
 * (HTTP headers received) and the server-side handler finishing its connection
 * registration.
 *
 * **The hooks have to be passed to the `buildApiRoute()` call that builds the
 * route.** The route builder captures them when it constructs the handler, so
 * attaching them to an already-built `RouteOptions` object has no effect. A
 * route owned by production code therefore has to accept SSE route options (or
 * the hooks themselves) as a parameter for a test to be able to spy on it.
 *
 * **Only useful for sessions that outlive the handler** — `keepAlive` sessions.
 * An `autoClose` route closes its session as the handler returns, before the
 * test can claim it, so `awaitServerConnection` on such a route races and
 * usually times out. Omit `awaitServerConnection` there and assert on the
 * events the client received instead.
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
 *
 * @example
 * ```typescript
 * // Route with lifecycle hooks of its own: compose instead of replacing them
 * const { spy, withSpy } = createSSESessionSpy()
 *
 * app.route(buildApiRoute(contract, handler, withSpy(productionRouteOptions)))
 * ```
 */
export function createSSESessionSpy<
  TSession extends SpiedSSESession = ApiSSESession,
>(): CreateSSESessionSpyResult<TSession> {
  const spy = new SSESessionSpy<TSession>()

  // `TOptions extends object` rather than `extends SSESessionSpyHooks`: with an
  // all-optional constraint, TypeScript falls back to the constraint itself for
  // an argument that declares no hooks, which would drop every other route
  // option from the result type. Hook compatibility is enforced by the
  // intersection in the parameter position instead.
  const withSpy = <TOptions extends object>(
    options?: TOptions & SSESessionSpyHooks<TSession>,
  ): Omit<TOptions, 'onConnect' | 'onClose'> & SSESessionSpyRouteOptions<TSession> => {
    const { onConnect, onClose, ...passThrough } =
      options ?? ({} as TOptions & SSESessionSpyHooks<TSession>)

    return {
      ...(passThrough as Omit<TOptions, 'onConnect' | 'onClose'>),
      onConnect: (connection) =>
        runHookThenNotify(
          () => onConnect?.(connection),
          () => spy.addConnection(connection),
        ),
      onClose: (connection, initiator) =>
        runHookThenNotify(
          () => onClose?.(connection, initiator),
          () => spy.addDisconnection(connection.id),
        ),
    }
  }

  return {
    spy,
    routeOptions: withSpy(),
    withSpy,
  }
}
