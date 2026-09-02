import { z } from 'zod/v4'
import { gatewayMetadataSchema } from '../gatewayMetadata.ts'

const httpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])

export const gatewayManifestRouteSchema = z
  .object({
    /** Stable id; defaults to "<controller>.<routeKey>" when not declared in metadata. */
    id: z.string(),
    method: httpMethodSchema,
    /** OpenAPI-style path: `/users/{userId}`. */
    path: z.string().startsWith('/'),
    /** Dependency-container name of the controller. */
    controller: z.string(),
    /** Key of the route inside the controller (`buildRoutes` map key, or array index for `AbstractApiController`). */
    routeKey: z.string(),
    /**
     * How the route responds on the success path: `'sse'` (always streams) or
     * `'dual'` (Accept-negotiated, stream or not). Absent for routes that
     * answer in a single response. Generators use this to apply
     * streaming-appropriate timeouts and disable response buffering.
     *
     * Success path only: a 4xx or 5xx is an ordinary JSON response on a
     * streaming route too, so a generator may size timeouts from this but must
     * not assume the content type of a failure.
     *
     * Additive optional field — manifests remain `manifestVersion: '1'`.
     * Because the schemas are `.strict()`, generators must run against a
     * library version that knows every field the manifest may carry (the
     * gateway packages' peerDependency floor tracks this).
     */
    streaming: z.enum(['sse', 'dual']).optional(),
    /**
     * For `streaming: 'dual'` routes, which branch serves a request whose
     * `Accept` header names neither type (absent, or a wildcard). Mirrors the
     * route's `defaultMode` option. Absent means `'non-sse'`.
     *
     * A generator that splits a dual route into a stream branch and a
     * catch-all needs this: with `'sse'` the catch-all is the STREAM, and
     * routing it as non-streaming would put a request timeout on a long-lived
     * stream.
     */
    streamingDefaultMode: z.enum(['non-sse', 'sse']).optional(),
    /** Already-merged metadata: service defaults → controller defaults → route. */
    metadata: gatewayMetadataSchema,
  })
  .strict()

export const gatewayManifestSchema = z
  .object({
    manifestVersion: z.literal('1'),
    service: z.string(),
    version: z.string().optional(),
    /** ISO-8601 timestamp. */
    generatedAt: z.string(),
    routes: z.array(gatewayManifestRouteSchema),
  })
  .strict()

export type GatewayManifestRoute = z.infer<typeof gatewayManifestRouteSchema>
export type GatewayManifest = z.infer<typeof gatewayManifestSchema>
