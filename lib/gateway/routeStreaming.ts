/**
 * Streaming marker for Fastify routes, mirroring the gateway-metadata symbol
 * pattern: stamped as a non-enumerable `Symbol.for` property by the route
 * builders, read back by the gateway manifest builder.
 *
 * Gateway config generators need to distinguish streaming routes (SSE and
 * dual-mode) from plain JSON routes — streaming routes must not inherit
 * request/idle timeouts sized for request-response traffic (e.g. Envoy's 15 s
 * route timeout and 5 min stream idle timeout both kill SSE streams).
 */

/**
 * Symbol used to attach the streaming mode to a Fastify route object.
 * `Symbol.for` ensures every module resolving the same key gets the same
 * symbol, even across realms or duplicate package copies.
 */
export const ROUTE_STREAMING_SYMBOL = Symbol.for('opinionated-machine.route.streaming')

/**
 * How a route streams:
 * - `'sse'` — SSE-only; every response is a `text/event-stream`.
 * - `'dual'` — Accept-negotiated; responses may be JSON or a stream.
 */
export type RouteStreamingMode = 'sse' | 'dual'

/**
 * Stamp the streaming mode onto a route via the non-enumerable
 * `ROUTE_STREAMING_SYMBOL` property. Fastify never sees it; the gateway
 * manifest builder reads it back. Returns the same route reference.
 */
export function attachRouteStreamingMode<Route extends object>(
  route: Route,
  mode: RouteStreamingMode,
): Route {
  Object.defineProperty(route, ROUTE_STREAMING_SYMBOL, {
    value: mode,
    enumerable: false,
    configurable: true,
    writable: true,
  })
  return route
}

/**
 * Read the streaming mode previously stamped on a route, or `undefined` for
 * plain (non-streaming) routes.
 */
export function readRouteStreamingMode(route: object): RouteStreamingMode | undefined {
  return (route as Record<symbol, RouteStreamingMode | undefined>)[ROUTE_STREAMING_SYMBOL]
}
