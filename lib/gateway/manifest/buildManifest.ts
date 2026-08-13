import type { RouteOptions } from 'fastify'
import { merge } from 'ts-deepmerge'
import type { AbstractController } from '../../AbstractController.ts'
import type { AbstractApiController } from '../../api-contracts/AbstractApiController.ts'
import type { AbstractDualModeController } from '../../dualmode/AbstractDualModeController.ts'
import { buildFastifyRoute } from '../../routes/fastifyRouteBuilder.ts'
import type { AbstractSSEController } from '../../sse/AbstractSSEController.ts'
import type { GatewayMetadataValue } from '../gatewayMetadata.ts'
import { readRouteStreamingMode } from '../routeStreaming.ts'
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
  /**
   * Include routes from legacy `AbstractSSEController` /
   * `AbstractDualModeController` controllers in the manifest (marked with
   * `streaming: 'sse' | 'dual'`). Off by default so existing manifests don't
   * silently gain routes; routes declared through `AbstractApiController` are
   * always included regardless of this flag.
   */
  includeStreamingControllers?: boolean
}

/**
 * Anything resolved from the DI container that may carry routes + gateway defaults.
 * Either `AbstractController` (REST) or `AbstractApiController` (api-contracts).
 *
 * The contract generic on `AbstractController` is erased here on purpose — the
 * manifest builder treats every route as a `RouteOptions` and reads the
 * gateway-metadata symbol regardless of contract shape.
 */
type CollectedController =
  | {
      name: string
      kind: 'rest'
      // biome-ignore lint/suspicious/noExplicitAny: contract generic erased at the manifest boundary
      controller: AbstractController<any>
    }
  // biome-ignore lint/suspicious/noExplicitAny: contract generic erased at the manifest boundary
  | { name: string; kind: 'api'; controller: AbstractApiController<any> }
  // biome-ignore lint/suspicious/noExplicitAny: contract generic erased at the manifest boundary
  | { name: string; kind: 'sse-legacy'; controller: AbstractSSEController<any> }
  // biome-ignore lint/suspicious/noExplicitAny: contract generic erased at the manifest boundary
  | { name: string; kind: 'dualmode-legacy'; controller: AbstractDualModeController<any> }

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
  if (collected.kind === 'rest') {
    const built = collected.controller.buildRoutes() as Record<string, RouteOptions>
    return Object.entries(built).map(([routeKey, route]) => ({ routeKey, route }))
  }
  if (collected.kind === 'sse-legacy' || collected.kind === 'dualmode-legacy') {
    // Legacy streaming controllers return branded handler containers; build
    // the Fastify RouteOptions from them (pure construction — no side
    // effects, no registration) so path/method/streaming can be read.
    const routeConfigs =
      collected.kind === 'sse-legacy'
        ? collected.controller.buildSSERoutes()
        : collected.controller.buildDualModeRoutes()
    return Object.entries(routeConfigs).map(([routeKey, routeConfig]) => ({
      routeKey,
      // biome-ignore lint/suspicious/noExplicitAny: overload selection erased at the manifest boundary
      route: buildFastifyRoute(collected.controller as any, routeConfig as any),
    }))
  }
  // AbstractApiController: routes is a Record — key becomes the routeKey.
  return Object.entries(collected.controller.routes).map(([routeKey, route]) => ({
    routeKey,
    route,
  }))
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

      const streaming = readRouteStreamingMode(route)
      routes.push({
        id,
        method,
        path,
        controller: collected.name,
        routeKey,
        ...(streaming !== undefined ? { streaming } : {}),
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
