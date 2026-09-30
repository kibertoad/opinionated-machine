import type { RouteOptions } from 'fastify'
import { merge } from 'ts-deepmerge'
import type { AbstractApiController } from '../../api-contracts/AbstractApiController.ts'
import type { GatewayMetadataValue } from '../gatewayMetadata.ts'
import { readRouteStreamingDefaultMode, readRouteStreamingMode } from '../routeStreaming.ts'
import { readGatewayMetadata } from '../withGatewayMetadata.ts'
import {
  type GatewayManifest,
  type GatewayManifestRoute,
  gatewayManifestSchema,
} from './manifestSchema.ts'
import { normalizePath } from './pathNormalize.ts'

export type BuildGatewayManifestOptions = {
  /** Logical service name written into the manifest. */
  service: string
  /** Optional service/release version (e.g. git SHA, semver) for traceability. */
  version?: string
  /** Service-wide metadata defaults; merged underneath controller- and route-level metadata. */
  defaults?: GatewayMetadataValue
}

/**
 * A controller resolved from the DI container, keyed by its dependency name.
 *
 * The contract generic on `AbstractApiController` is erased here on purpose —
 * the manifest builder treats every route as a `RouteOptions` and reads the
 * gateway-metadata symbol regardless of contract shape.
 */
type CollectedController = {
  name: string
  // biome-ignore lint/suspicious/noExplicitAny: contract generic erased at the manifest boundary
  controller: AbstractApiController<any>
}

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const
type CanonicalMethod = (typeof HTTP_METHODS)[number]

function normalizeMethod(method: RouteOptions['method']): CanonicalMethod {
  if (Array.isArray(method)) {
    throw new Error(
      `Gateway manifest does not support multi-method routes (got [${method.join(', ')}]). Declare one route per method.`,
    )
  }
  const upper = String(method).toUpperCase()
  if (!HTTP_METHODS.includes(upper as CanonicalMethod)) {
    throw new Error(`Unsupported HTTP method "${method}" in gateway manifest`)
  }
  return upper as CanonicalMethod
}

function mergeMetadata(layers: Array<GatewayMetadataValue | undefined>): GatewayMetadataValue {
  const present = layers.filter((m): m is GatewayMetadataValue => m !== undefined)
  if (present.length === 0) return {}
  if (present.length === 1) return present[0] as GatewayMetadataValue
  // ts-deepmerge replaces arrays in later layers (documented merge semantics).
  // biome-ignore lint/suspicious/noExplicitAny: ts-deepmerge generic doesn't cleanly express this
  return merge.withOptions({ mergeArrays: false }, ...(present as any[])) as GatewayMetadataValue
}

function collectRouteEntries(
  collected: CollectedController,
): Array<{ routeKey: string; route: RouteOptions }> {
  // `routes` is a Record — key becomes the routeKey.
  return Object.entries(collected.controller.routes).map(([routeKey, route]) => ({
    routeKey,
    route,
  }))
}

/**
 * The manifest's streaming fields for one Fastify route, read back from the
 * markers the route builders stamped.
 */
function readStreamingFields(
  route: object,
): Pick<GatewayManifestRoute, 'streaming' | 'streamingDefaultMode'> {
  const streaming = readRouteStreamingMode(route)
  if (streaming === undefined) return {}
  const defaultMode = readRouteStreamingDefaultMode(route)
  // Only a dual route negotiates, so a fallback branch is meaningless on an
  // SSE-only one.
  return streaming === 'dual' && defaultMode !== undefined
    ? { streaming, streamingDefaultMode: defaultMode }
    : { streaming }
}

/**
 * Pure manifest builder. Takes already-resolved controllers; performs no DI.
 *
 * Used by `DIContext.buildGatewayManifest()` after it resolves controllers from
 * the container. Exposed separately for unit testing without spinning up a DI
 * context.
 */
export function buildGatewayManifestFrom(
  controllers: ReadonlyArray<CollectedController>,
  options: BuildGatewayManifestOptions,
): GatewayManifest {
  const routes: GatewayManifestRoute[] = []
  // Track route ids back to their origin so we can produce a useful error
  // message if two declarations end up with the same explicit metadata.id.
  const idOrigin = new Map<string, string>()

  for (const collected of controllers) {
    const controllerDefaults = collected.controller.gatewayDefaults
    for (const { routeKey, route } of collectRouteEntries(collected)) {
      const routeMetadata = readGatewayMetadata(route)
      const merged = mergeMetadata([options.defaults, controllerDefaults, routeMetadata])

      if (route.url === undefined) {
        throw new Error(
          `Route "${collected.name}.${routeKey}" is missing a URL — gateway manifest cannot be generated.`,
        )
      }
      const path = normalizePath(route.url)
      const method = normalizeMethod(route.method)
      const origin = `${collected.name}.${routeKey}`
      const id = merged.id ?? origin

      const previousOrigin = idOrigin.get(id)
      if (previousOrigin) {
        throw new Error(
          `Duplicate gateway route id "${id}": declared by both ${previousOrigin} and ${origin}. Set a distinct metadata.id on one of them.`,
        )
      }
      idOrigin.set(id, origin)

      routes.push({
        id,
        method,
        path,
        controller: collected.name,
        routeKey,
        ...readStreamingFields(route),
        metadata: merged,
      })
    }
  }

  // Sort for stable output across runs (gateways like deterministic configs).
  routes.sort((a, b) =>
    a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path),
  )

  const manifest = {
    manifestVersion: '1' as const,
    service: options.service,
    ...(options.version !== undefined ? { version: options.version } : {}),
    generatedAt: new Date().toISOString(),
    routes,
  }

  // Validate the per-route merged metadata too. The route-level types narrow
  // header/query keys, but service- and controller-level defaults are
  // contract-unbound, so a runtime check at the boundary protects generators.
  return gatewayManifestSchema.parse(manifest)
}

export type { CollectedController }
