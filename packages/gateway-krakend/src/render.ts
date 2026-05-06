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

    if (route.metadata.headers?.request?.add) {
      warnings.push(
        `Route "${route.id}": metadata.headers.request.add is not natively expressed in KrakenD; use extensions.krakend or a Lua plugin if needed.`,
      )
    }
    if (route.metadata.match?.host) {
      warnings.push(
        `Route "${route.id}": metadata.match.host has no direct KrakenD equivalent — host routing is typically handled at the listener level.`,
      )
    }

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
  const base = {
    max_rate: rateLimit.requests,
    every: toKrakendDuration(rateLimit.per),
  }
  const key = rateLimit.key
  if (key === 'ip') {
    return { ...base, client_max_rate: rateLimit.requests, strategy: 'ip' }
  }
  if (key && typeof key === 'object' && 'header' in key) {
    return { ...base, client_max_rate: rateLimit.requests, strategy: 'header', key: key.header }
  }
  if (key && typeof key === 'object' && 'customHeader' in key) {
    return {
      ...base,
      client_max_rate: rateLimit.requests,
      strategy: 'header',
      key: key.customHeader,
    }
  }
  return base
}

function buildCircuitBreakerExtra(
  cb: NonNullable<GatewayMetadataValue['circuitBreaker']>,
): Record<string, unknown> {
  return {
    ...(cb.maxRequests !== undefined ? { max_requests: cb.maxRequests } : {}),
    ...(cb.maxRetries !== undefined ? { max_retries: cb.maxRetries } : {}),
  }
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
  if (meta.circuitBreaker)
    extra['qos/circuit-breaker'] = buildCircuitBreakerExtra(meta.circuitBreaker)
  if (meta.auth?.jwt) extra['auth/validator'] = buildJwtExtra(meta.auth.jwt)

  if (meta.retry?.attempts !== undefined) {
    warnings.push(
      `Route "${routeId}": metadata.retry is best modelled in KrakenD via the backend "backend/http/client" config; v1 emits attempts only on a best-effort basis.`,
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
