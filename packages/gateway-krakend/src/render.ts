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
      backend: [
        {
          host: [upstreamHost],
          url_pattern: applyRewrite(route.path, route.metadata.rewrite),
          encoding: 'no-op',
          ...(route.metadata.timeouts?.request
            ? {
                extra_config: {
                  'backend/http/client': {
                    timeout: toKrakendDuration(route.metadata.timeouts.request),
                  },
                },
              }
            : {}),
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
    extra_config: buildGlobalExtraConfig(manifest),
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
  rateLimit: NonNullable<GatewayMetadataValue['rateLimit']>,
): Record<string, unknown> {
  // KrakenD distinguishes global (max_rate) from per-client (client_max_rate).
  // Setting both to the same value would let the global cap dominate and
  // make the per-client part dead, so we emit one or the other based on key.
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
  if (meta.rateLimit) extra['qos/ratelimit/router'] = buildRateLimitExtra(meta.rateLimit)
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

  // Vendor escape hatch: deep-merge extensions.krakend last.
  const krakendExt = meta.extensions?.krakend as Record<string, unknown> | undefined
  if (krakendExt) {
    Object.assign(extra, krakendExt)
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

function buildGlobalExtraConfig(manifest: GatewayManifest): Record<string, unknown> {
  // Promote the first route-level CORS block to the listener — KrakenD applies
  // CORS globally rather than per-endpoint.
  const firstCors = manifest.routes.find((r) => r.metadata.cors)?.metadata.cors
  return firstCors ? buildCorsGlobalConfig(firstCors) : {}
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
