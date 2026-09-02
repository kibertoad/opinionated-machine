/**
 * Streaming marker for Fastify routes, mirroring the gateway-metadata symbol
 * pattern: stamped as a non-enumerable `Symbol.for` property by the route
 * builders, read back by the gateway manifest builder.
 *
 * Gateway config generators need to tell streaming routes (SSE and dual-mode)
 * apart from ones that answer in a single response, because a streaming route
 * must not inherit timeouts sized for request-response traffic (Envoy's 15 s
 * route timeout and 5 min stream idle timeout both kill an SSE stream).
 */

/**
 * Symbol used to attach the streaming mode to a Fastify route object.
 * `Symbol.for` ensures every module resolving the same key gets the same
 * symbol, even across realms or duplicate package copies.
 */
export const ROUTE_STREAMING_SYMBOL = Symbol.for('opinionated-machine.route.streaming')

/**
 * How a route responds **on the success path**:
 *
 * - `'sse'`: every successful response is a `text/event-stream`.
 * - `'dual'`: Accept-negotiated, so a successful response is either a stream or
 *   a non-SSE body.
 *
 * Failures are not covered by either value. A 4xx or 5xx is an ordinary JSON
 * response on both kinds of route, including the early-return
 * `sse.respond(404, ...)` path that answers before the stream starts. So a
 * generator can size timeouts and buffering from this marker, but must not
 * assume the content type of a response that failed.
 *
 * Named to match `ContractResponseMode` in `@lokalise/api-contracts`.
 */
export type RouteStreamingMode = 'sse' | 'dual'

/**
 * Which branch a dual-mode route serves when the client does not ask for one
 * specifically (no `Accept` header, or `Accept: *\/*`). Mirrors the
 * `defaultMode` route option that `determineMode()` falls back to.
 *
 * A gateway that splits a dual route into two must know this, or it applies
 * request-shaped timeouts to a response that is actually a stream.
 *
 * `'non-sse'` rather than `'json'`, matching `ContractResponseMode` in
 * `@lokalise/api-contracts`: the branch that does not stream events is a JSON
 * body on most routes, but it can equally be a blob (a generated PDF, an
 * export), and nothing here depends on which.
 */
export type RouteStreamingDefaultMode = 'non-sse' | 'sse'

/**
 * Symbol carrying the dual-mode fallback branch, stamped alongside
 * {@link ROUTE_STREAMING_SYMBOL}.
 */
export const ROUTE_STREAMING_DEFAULT_MODE_SYMBOL = Symbol.for(
  'opinionated-machine.route.streaming.defaultMode',
)

/**
 * Stamp the streaming mode onto a route via the non-enumerable
 * `ROUTE_STREAMING_SYMBOL` property. Fastify never sees it; the gateway
 * manifest builder reads it back. Returns the same route reference.
 *
 * For `'dual'` routes pass `defaultMode` as well, so the manifest can tell a
 * generator which branch an unspecific `Accept` header lands on.
 *
 * Generic in `Route` because it hands the same object back and the caller keeps
 * its type. Spreading a stamped route drops the marker: the property is
 * non-enumerable by design, so stamp last.
 */
export function attachRouteStreamingMode<Route extends object>(
  route: Route,
  mode: RouteStreamingMode,
  defaultMode?: RouteStreamingDefaultMode,
): Route {
  Object.defineProperty(route, ROUTE_STREAMING_SYMBOL, {
    value: mode,
    enumerable: false,
    configurable: true,
    writable: true,
  })
  if (defaultMode !== undefined) {
    Object.defineProperty(route, ROUTE_STREAMING_DEFAULT_MODE_SYMBOL, {
      value: defaultMode,
      enumerable: false,
      configurable: true,
      writable: true,
    })
  }
  return route
}

/**
 * Read the streaming mode previously stamped on a route, or `undefined` for a
 * route that carries no marker.
 *
 * Takes `object` rather than a type parameter: the value lives in a symbol
 * property, so nothing about the route's own shape is read or returned, and a
 * generic here would infer a type it then throws away. The manifest builder
 * calls this with routes it knows only as objects.
 */
export function readRouteStreamingMode(route: object): RouteStreamingMode | undefined {
  return (route as Record<symbol, RouteStreamingMode | undefined>)[ROUTE_STREAMING_SYMBOL]
}

/**
 * Read the dual-mode fallback branch previously stamped on a route, or
 * `undefined` when the route did not declare one.
 */
export function readRouteStreamingDefaultMode(
  route: object,
): RouteStreamingDefaultMode | undefined {
  return (route as Record<symbol, RouteStreamingDefaultMode | undefined>)[
    ROUTE_STREAMING_DEFAULT_MODE_SYMBOL
  ]
}
