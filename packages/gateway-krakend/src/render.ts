import type { GatewayManifest, GatewayMetadataValue } from 'opinionated-machine'
import { toKrakendDuration } from './durations.ts'

export type KrakendOptions = {
  /** KrakenD listener port. */
  port: number
  /** Map from `metadata.upstream` to base URL (e.g. `http://users:8081`). */
  upstreams: Record<string, string>
  /** Optional name for the resulting config; defaults to manifest.service. */
  name?: string
}

export type RenderKrakendResult = {
  json: KrakendConfigShape
  warnings: string[]
}

/**
 * Render a KrakenD v3 configuration object from a gateway manifest.
 *
 * KrakenD's `{var}` path syntax is native, so paths pass through unchanged.
 * Cache and rate-limit are first-class in KrakenD, so this generator covers
 * those (whereas the Envoy generator does not in v1).
 */
export function renderKrakendConfig(
  manifest: GatewayManifest,
  options: KrakendOptions,
): RenderKrakendResult {
  const warnings: string[] = []

  const endpoints = manifest.routes.map((route) => {
    if (!route.metadata.upstream) {
      throw new Error(
        `Route "${route.id}" has no upstream — set metadata.upstream on the route or controller defaults.`,
      )
    }
    const upstreamHost = options.upstreams[route.metadata.upstream]
    if (!upstreamHost) {
      throw new Error(
        `Manifest references upstream "${route.metadata.upstream}" but no host was configured in KrakendOptions.upstreams.`,
      )
    }

    const endpoint: KrakendEndpoint = {
      endpoint: route.path,
      method: route.method,
      output_encoding: 'no-op',
      // KrakenD's request timeout is an endpoint-level field, NOT a
      // `backend/http/client` extra_config — that plugin doesn't have a
      // `timeout` setting and silently ignores it.
      ...(route.metadata.timeouts?.request
        ? { timeout: toKrakendDuration(route.metadata.timeouts.request) }
        : {}),
      backend: [
        {
          host: [upstreamHost],
          url_pattern: applyRewrite(route.path, route.metadata.rewrite),
          encoding: 'no-op',
        },
      ],
    }

    const extraConfig = buildEndpointExtraConfig(route.id, route.metadata, warnings)
    if (Object.keys(extraConfig).length > 0) {
      endpoint.extra_config = extraConfig
    }

    collectUnsupportedWarnings(route.id, route.metadata, warnings)

    return endpoint
  })

  const config: KrakendConfigShape = {
    version: 3,
    name: options.name ?? manifest.service,
    port: options.port,
    endpoints,
    extra_config: buildGlobalExtraConfig(manifest, warnings),
  }

  return { json: config, warnings }
}

function collectUnsupportedWarnings(
  routeId: string,
  meta: GatewayMetadataValue,
  warnings: string[],
): void {
  if (meta.headers?.request?.add || meta.headers?.request?.remove) {
    warnings.push(
      `Route "${routeId}": metadata.headers.request is not natively expressed in KrakenD; use extensions.krakend or a Lua plugin.`,
    )
  }
  if (meta.headers?.response?.add || meta.headers?.response?.remove) {
    warnings.push(
      `Route "${routeId}": metadata.headers.response is not natively expressed in KrakenD; use extensions.krakend or a Lua plugin.`,
    )
  }
  if (meta.match?.host) {
    warnings.push(
      `Route "${routeId}": metadata.match.host has no direct KrakenD equivalent — host routing is typically handled at the listener level.`,
    )
  }
  if (meta.traffic?.weights || meta.traffic?.shadow) {
    warnings.push(
      `Route "${routeId}": metadata.traffic (weighted / shadow) is not modelled in KrakenD — set up a separate KrakenD instance or use extensions.krakend.`,
    )
  }
  if (meta.auth?.required && !meta.auth.jwt) {
    warnings.push(
      `Route "${routeId}": metadata.auth.required without auth.jwt has no automatic mapping — wire authentication via extensions.krakend.`,
    )
  }
  if (meta.auth?.mTLS) {
    warnings.push(
      `Route "${routeId}": metadata.auth.mTLS is not modelled — terminate mTLS at the listener / reverse proxy in front of KrakenD.`,
    )
  }
}

function applyRewrite(path: string, rewrite: GatewayMetadataValue['rewrite']): string {
  if (rewrite?.replacePrefix) {
    return path.startsWith(rewrite.replacePrefix.from)
      ? rewrite.replacePrefix.to + path.slice(rewrite.replacePrefix.from.length)
      : path
  }
  if (rewrite?.stripPrefix) {
    return path.startsWith(rewrite.stripPrefix)
      ? path.slice(rewrite.stripPrefix.length) || '/'
      : path
  }
  return path
}

function buildCacheExtra(
  cache: NonNullable<GatewayMetadataValue['cache']>,
): Record<string, unknown> {
  return {
    ttl: toKrakendDuration(cache.ttl),
    ...(cache.vary?.length ? { vary: cache.vary } : {}),
  }
}

function buildRateLimitExtra(
  routeId: string,
  rateLimit: NonNullable<GatewayMetadataValue['rateLimit']>,
  warnings: string[],
): Record<string, unknown> {
  // KrakenD's qos/ratelimit/router distinguishes:
  //   - max_rate          shared cap across all clients
  //   - client_max_rate   per-client cap, partitioned by `strategy` + `key`
  //     - strategy: 'ip' | 'header'   are the OSS-supported shapes
  // `query` / `customQuery` keys from the universal model have no OSS
  // equivalent — surface a warning and fall back to a shared cap rather
  // than silently demoting the policy to a different identity.
  const every = toKrakendDuration(rateLimit.per)
  const key = rateLimit.key
  if (key === 'ip') {
    return { client_max_rate: rateLimit.requests, every, strategy: 'ip' }
  }
  if (key && typeof key === 'object' && 'header' in key) {
    return {
      client_max_rate: rateLimit.requests,
      every,
      strategy: 'header',
      key: key.header,
    }
  }
  if (key && typeof key === 'object' && 'customHeader' in key) {
    return {
      client_max_rate: rateLimit.requests,
      every,
      strategy: 'header',
      key: key.customHeader,
    }
  }
  if (key && typeof key === 'object' && ('query' in key || 'customQuery' in key)) {
    const queryKey = 'query' in key ? key.query : key.customQuery
    warnings.push(
      `Route "${routeId}": KrakenD's qos/ratelimit/router has no querystring strategy — metadata.rateLimit.key='${queryKey}' is being demoted to a shared max_rate. Wire a custom plugin via extensions.krakend if true per-query-value limiting is needed.`,
    )
    return { max_rate: rateLimit.requests, every }
  }
  return { max_rate: rateLimit.requests, every }
}

function buildJwtExtra(
  jwt: NonNullable<NonNullable<GatewayMetadataValue['auth']>['jwt']>,
): Record<string, unknown> {
  return {
    alg: 'RS256',
    issuer: jwt.issuer,
    ...(jwt.audiences?.length ? { audience: jwt.audiences } : {}),
    ...(jwt.jwksUri ? { jwk_url: jwt.jwksUri } : {}),
  }
}

function buildEndpointExtraConfig(
  routeId: string,
  meta: GatewayMetadataValue,
  warnings: string[],
): Record<string, unknown> {
  const extra: Record<string, unknown> = {}

  if (meta.cache?.ttl) extra['qos/http-cache'] = buildCacheExtra(meta.cache)
  if (meta.rateLimit) {
    extra['qos/ratelimit/router'] = buildRateLimitExtra(routeId, meta.rateLimit, warnings)
  }
  if (meta.auth?.jwt) extra['auth/validator'] = buildJwtExtra(meta.auth.jwt)

  if (meta.circuitBreaker) {
    // The universal model is Envoy-style (concurrency limits). KrakenD's
    // qos/circuit-breaker is error-rate-based (max_errors / interval), a
    // different abstraction — wire it via extensions.krakend if you need it.
    warnings.push(
      `Route "${routeId}": metadata.circuitBreaker (concurrency limits) doesn't translate to KrakenD's error-rate-based qos/circuit-breaker — set extensions.krakend["qos/circuit-breaker"] explicitly if you want it.`,
    )
  }

  if (meta.retry?.attempts !== undefined) {
    warnings.push(
      `Route "${routeId}": metadata.retry is best modelled in KrakenD under backend/http/client; this generator does not emit it — set extensions.krakend["backend/http/client"] explicitly.`,
    )
  }

  // Vendor escape hatch: deep-merge extensions.krakend per extra-config
  // block. Shallow assignment would let a partial extension like
  // `extensions.krakend['qos/http-cache'] = { vary: ['x-region'] }` clobber
  // the `ttl` / `methods` we already emitted into the same key.
  const krakendExt = meta.extensions?.krakend as Record<string, unknown> | undefined
  if (krakendExt) {
    for (const [key, value] of Object.entries(krakendExt)) {
      const existing = extra[key]
      if (
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        existing &&
        typeof existing === 'object' &&
        !Array.isArray(existing)
      ) {
        extra[key] = {
          ...(existing as Record<string, unknown>),
          ...(value as Record<string, unknown>),
        }
      } else {
        extra[key] = value
      }
    }
  }

  return extra
}

function buildCorsGlobalConfig(
  cors: NonNullable<GatewayMetadataValue['cors']>,
): Record<string, unknown> {
  return {
    'security/cors': {
      allow_origins: cors.origins,
      ...(cors.methods ? { allow_methods: cors.methods } : {}),
      ...(cors.headers ? { allow_headers: cors.headers } : {}),
      ...(cors.exposeHeaders ? { expose_headers: cors.exposeHeaders } : {}),
      ...(cors.credentials !== undefined ? { allow_credentials: cors.credentials } : {}),
      ...(cors.maxAge ? { max_age: toKrakendDuration(cors.maxAge) } : {}),
    },
  }
}

function buildGlobalExtraConfig(
  manifest: GatewayManifest,
  warnings: string[],
): Record<string, unknown> {
  // KrakenD's CORS plugin only attaches at the service (root) level — there
  // is no per-endpoint CORS plugin in OSS KrakenD. We promote the first
  // declared CORS block to global; if there are multiple distinct ones,
  // we warn so the operator knows the others are being dropped.
  const corsRoutes = manifest.routes.filter((r) => r.metadata.cors)
  if (corsRoutes.length === 0) return {}

  const distinct = new Set(corsRoutes.map((r) => JSON.stringify(r.metadata.cors)))
  if (distinct.size > 1) {
    warnings.push(
      `Multiple distinct metadata.cors blocks found across routes; KrakenD only supports a single global CORS policy, so the first one is being applied to all routes. The others (from routes ${corsRoutes
        .slice(1)
        .map((r) => `"${r.id}"`)
        .join(', ')}) are being dropped.`,
    )
  }
  // corsRoutes was filtered to entries with metadata.cors set, so the cast
  // is just stripping the index-signature undefined.
  const first = corsRoutes[0] as (typeof corsRoutes)[number]
  return buildCorsGlobalConfig(first.metadata.cors as NonNullable<typeof first.metadata.cors>)
}

// ============================================================================
// Type definitions for the KrakenD subset we emit.
// ============================================================================

type KrakendBackend = {
  host: string[]
  url_pattern: string
  encoding: string
  extra_config?: Record<string, unknown>
}

type KrakendEndpoint = {
  endpoint: string
  method: string
  output_encoding: string
  /** Endpoint-level request timeout (e.g. "200ms", "5s"). */
  timeout?: string
  backend: KrakendBackend[]
  extra_config?: Record<string, unknown>
}

export type KrakendConfigShape = {
  version: 3
  name: string
  port: number
  endpoints: KrakendEndpoint[]
  extra_config: Record<string, unknown>
}
