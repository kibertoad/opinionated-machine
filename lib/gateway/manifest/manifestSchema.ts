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
