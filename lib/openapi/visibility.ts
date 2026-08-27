import type { FastifySchema } from 'fastify'

/**
 * Contract visibility as declared by `@lokalise/api-contracts` (v8+).
 *
 * `'public'` and `'internal'` are the values the contract builders ship today;
 * the open-ended union keeps forward compatibility with additional audiences
 * (e.g. `'partner'`) without a breaking change here.
 */
export type RouteVisibility = 'public' | 'internal' | (string & Record<never, never>)

/**
 * Key under which route builders record the contract's visibility on the
 * Fastify route schema.
 *
 * Deliberately *not* prefixed with `x-`: `@fastify/swagger` copies every
 * `x-`-prefixed schema key verbatim into the generated operation object, and
 * the raw visibility of a route is an implementation detail that should never
 * leak into a published document unless a transform puts it there on purpose.
 */
export const VISIBILITY_SCHEMA_KEY = 'visibility'

/**
 * A Fastify route schema as `@fastify/swagger` sees it: the standard Fastify
 * fields, the swagger-specific extras (`hide`, `summary`, `description`,
 * `tags`), plus the `visibility` marker this package stamps.
 */
export type OpenApiRouteSchema = FastifySchema & {
  /** When true, `@fastify/swagger` leaves the route out of the document. */
  hide?: boolean
  summary?: string
  description?: string
  tags?: readonly string[]
  /** Contract visibility, stamped by the opinionated-machine route builders. */
  visibility?: RouteVisibility
}

/**
 * Record the contract's visibility on a route's schema so that OpenAPI
 * transforms can tell *why* a route is hidden.
 *
 * `hide: true` on its own is lossy — it cannot distinguish "hidden because the
 * contract is internal" (which the internal document wants to un-hide) from
 * "hidden on purpose, everywhere". Stamping the visibility keeps that
 * distinction available to {@link openApiVisibilityTransform}.
 *
 * Mutates and returns the same route reference; the schema object is created
 * if the route does not have one yet. Passing `undefined` is a no-op, so
 * routes built from contracts compiled against a pre-visibility
 * `@lokalise/api-contracts` behave exactly as before.
 */
export function attachRouteVisibility<Route extends { schema?: unknown }>(
  route: Route,
  visibility: RouteVisibility | undefined,
): Route {
  if (visibility === undefined) return route

  const schema = (route.schema ?? {}) as OpenApiRouteSchema
  schema[VISIBILITY_SCHEMA_KEY] = visibility
  ;(route as { schema?: unknown }).schema = schema
  return route
}

/** Read back the visibility stamped by {@link attachRouteVisibility}. */
export function readRouteVisibility(route: { schema?: unknown }): RouteVisibility | undefined {
  const schema = route.schema as OpenApiRouteSchema | undefined
  return schema?.[VISIBILITY_SCHEMA_KEY] as RouteVisibility | undefined
}
