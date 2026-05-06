import type { GatewayManifest, GatewayMetadataValue } from 'opinionated-machine'
import { stringify as stringifyYaml } from 'yaml'
import { toMilliseconds, toSeconds } from './durations.ts'
import { openApiPathToKong } from './pathMatch.ts'

export type KongUpstreamOptions = {
  /** Base URL for the upstream service (e.g. `http://users:8081`). */
  url: string
  /** Optional Kong service-level retry count. */
  retries?: number
}

export type KongOptions = {
  /** Map from `metadata.upstream` to the upstream URL Kong should proxy to. */
  upstreams: Record<string, KongUpstreamOptions>
}

export type RenderKongResult = {
  yaml: string
  json: KongConfigShape
  warnings: string[]
}

/**
 * Render a Kong **declarative** (DB-less) configuration from a gateway manifest.
 *
 * Kong's plugin model is the natural fit for most gateway-metadata fields:
 * timeouts and retries map onto service attributes, while rate-limiting,
 * CORS, JWT, caching, and header transformations map onto first-class
 * plugins. Anything that doesn't have a clean Kong CE equivalent (traffic
 * splitting, circuit breaker) is reported as a warning.
 */
export function renderKongConfig(
  manifest: GatewayManifest,
  options: KongOptions,
): RenderKongResult {
  const warnings: string[] = []

  // Group routes by upstream so we emit one Kong service per upstream.
  const byUpstream = new Map<string, GatewayManifest['routes']>()
  for (const route of manifest.routes) {
    if (!route.metadata.upstream) {
      throw new Error(
        `Route "${route.id}" has no upstream — set metadata.upstream on the route or controller defaults.`,
      )
    }
    const list = byUpstream.get(route.metadata.upstream) ?? []
    list.push(route)
    byUpstream.set(route.metadata.upstream, list)
  }

  for (const upstream of byUpstream.keys()) {
    if (!options.upstreams[upstream]) {
      throw new Error(
        `Manifest references upstream "${upstream}" but no URL was configured in KongOptions.upstreams.`,
      )
    }
  }

  const services: KongService[] = []
  for (const [upstreamName, routes] of byUpstream) {
    const upstreamOpts = options.upstreams[upstreamName] as KongUpstreamOptions
    services.push(buildService(upstreamName, upstreamOpts, routes, warnings))
  }
  services.sort((a, b) => a.name.localeCompare(b.name))

  const config: KongConfigShape = {
    _format_version: '3.0',
    _transform: true,
    services,
    plugins: collectGlobalPlugins(manifest, warnings),
  }

  return {
    yaml: stringifyYaml(config, { indent: 2 }),
    json: config,
    warnings,
  }
}

function buildService(
  name: string,
  upstreamOpts: KongUpstreamOptions,
  routes: GatewayManifest['routes'],
  warnings: string[],
): KongService {
  const url = new URL(upstreamOpts.url)
  // Use the maximum of all route timeouts as the service-level read_timeout
  // (Kong's read_timeout applies to upstream reads). Per-route overrides ride
  // on the route via the `request-termination`-style plugin below if needed.
  const readTimeout = pickTightestTimeout(routes)

  return {
    name,
    protocol: url.protocol.replace(':', ''),
    host: url.hostname,
    port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80,
    path: url.pathname === '/' ? undefined : url.pathname,
    ...(upstreamOpts.retries !== undefined ? { retries: upstreamOpts.retries } : {}),
    ...(readTimeout !== undefined ? { read_timeout: readTimeout } : {}),
    routes: routes
      .map((route) => buildRoute(route, warnings))
      .sort((a, b) => a.name.localeCompare(b.name)),
  }
}

function pickTightestTimeout(routes: GatewayManifest['routes']): number | undefined {
  let tightest: number | undefined
  for (const route of routes) {
    const timeout = route.metadata.timeouts?.request
    if (!timeout) continue
    const ms = toMilliseconds(timeout)
    if (tightest === undefined || ms < tightest) tightest = ms
  }
  return tightest
}

function buildRoute(route: GatewayManifest['routes'][number], warnings: string[]): KongRoute {
  const meta = route.metadata
  const headers = collectHeaderMatchers(meta)

  const r: KongRoute = {
    name: route.id,
    methods: [route.method],
    paths: [openApiPathToKong(route.path)],
    strip_path: meta.rewrite?.stripPrefix !== undefined,
    preserve_host: false,
    ...(headers ? { headers } : {}),
    plugins: collectRoutePlugins(route.id, meta, warnings),
  }
  if (r.plugins?.length === 0) delete r.plugins

  // Vendor escape hatch: extensions.kong is shallow-merged onto the route.
  const kongExt = meta.extensions?.kong as Record<string, unknown> | undefined
  if (kongExt) Object.assign(r, kongExt)

  return r
}

function collectHeaderMatchers(meta: GatewayMetadataValue): Record<string, string[]> | undefined {
  const out: Record<string, string[]> = {}
  const merged = { ...(meta.match?.headers ?? {}), ...(meta.match?.customHeaders ?? {}) }
  for (const [name, rule] of Object.entries(merged)) {
    if (typeof rule === 'string') {
      out[name] = [rule]
      continue
    }
    if ('exact' in rule) out[name] = [rule.exact]
    else if ('prefix' in rule) out[name] = [`~^${escapeRegex(rule.prefix)}`]
    else if ('regex' in rule) out[name] = [`~${rule.regex}`]
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function collectRoutePlugins(
  routeId: string,
  meta: GatewayMetadataValue,
  warnings: string[],
): KongPlugin[] {
  const plugins: KongPlugin[] = []

  if (meta.rateLimit) plugins.push(buildRateLimitPlugin(meta.rateLimit))
  if (meta.cache?.ttl) plugins.push(buildCachePlugin(meta.cache))
  if (meta.auth?.jwt) plugins.push(buildJwtPlugin())
  const transformer = buildTransformerPlugins(meta.headers)
  plugins.push(...transformer)

  if (meta.circuitBreaker) {
    warnings.push(
      `Route "${routeId}": metadata.circuitBreaker has no native equivalent in Kong CE — consider Kong Enterprise or a service-mesh layer.`,
    )
  }
  if (meta.traffic?.weights || meta.traffic?.shadow) {
    warnings.push(
      `Route "${routeId}": metadata.traffic (weighted / shadow) is not modelled in v1; configure Kong upstreams + targets manually if needed.`,
    )
  }

  // Vendor escape hatch: meta.extensions.kong_plugins (array) is appended.
  const extPlugins = (meta.extensions?.kong_plugins as KongPlugin[] | undefined) ?? []
  plugins.push(...extPlugins)

  return plugins
}

function buildRateLimitPlugin(
  rateLimit: NonNullable<GatewayMetadataValue['rateLimit']>,
): KongPlugin {
  const seconds = toSeconds(rateLimit.per)
  // Map per-second / per-minute / per-hour buckets to Kong's discrete fields.
  const config: Record<string, unknown> = {}
  if (seconds <= 1) config.second = rateLimit.requests
  else if (seconds <= 60) config.minute = rateLimit.requests
  else if (seconds <= 3600) config.hour = rateLimit.requests
  else config.day = rateLimit.requests

  const key = rateLimit.key
  config.limit_by =
    key === 'ip'
      ? 'ip'
      : key && typeof key === 'object' && ('header' in key || 'customHeader' in key)
        ? 'header'
        : 'consumer'
  if (key && typeof key === 'object' && 'header' in key) {
    config.header_name = key.header
  } else if (key && typeof key === 'object' && 'customHeader' in key) {
    config.header_name = key.customHeader
  }

  return { name: 'rate-limiting', config }
}

function buildCachePlugin(cache: NonNullable<GatewayMetadataValue['cache']>): KongPlugin {
  return {
    name: 'proxy-cache',
    config: {
      strategy: 'memory',
      cache_ttl: toSeconds(cache.ttl),
      ...(cache.methods?.length ? { request_method: cache.methods } : {}),
      ...(cache.vary?.length ? { vary_headers: cache.vary } : {}),
    },
  }
}

function buildJwtPlugin(): KongPlugin {
  // Kong's JWT plugin draws its keys from consumers/credentials, not from a
  // jwks URI in declarative config. We emit the plugin as a marker so
  // operators can wire credentials separately.
  return { name: 'jwt', config: {} }
}

function buildTransformerPlugins(headers: GatewayMetadataValue['headers']): KongPlugin[] {
  const out: KongPlugin[] = []
  if (headers?.request) {
    const config: Record<string, unknown> = {}
    if (headers.request.add) {
      config.add = { headers: Object.entries(headers.request.add).map(([k, v]) => `${k}:${v}`) }
    }
    if (headers.request.remove?.length) {
      config.remove = { headers: headers.request.remove }
    }
    if (Object.keys(config).length > 0) out.push({ name: 'request-transformer', config })
  }
  if (headers?.response) {
    const config: Record<string, unknown> = {}
    if (headers.response.add) {
      config.add = { headers: Object.entries(headers.response.add).map(([k, v]) => `${k}:${v}`) }
    }
    if (headers.response.remove?.length) {
      config.remove = { headers: headers.response.remove }
    }
    if (Object.keys(config).length > 0) out.push({ name: 'response-transformer', config })
  }
  return out
}

function collectGlobalPlugins(manifest: GatewayManifest, _warnings: string[]): KongPlugin[] {
  // Promote the first route-level CORS block to a global Kong plugin —
  // Kong applies CORS at the global / service / route level, and aggregating
  // it once keeps the config tidy.
  const firstCors = manifest.routes.find((r) => r.metadata.cors)?.metadata.cors
  if (!firstCors) return []
  return [
    {
      name: 'cors',
      config: {
        origins: firstCors.origins,
        ...(firstCors.methods ? { methods: firstCors.methods } : {}),
        ...(firstCors.headers ? { headers: firstCors.headers } : {}),
        ...(firstCors.exposeHeaders ? { exposed_headers: firstCors.exposeHeaders } : {}),
        ...(firstCors.credentials !== undefined ? { credentials: firstCors.credentials } : {}),
        ...(firstCors.maxAge ? { max_age: toSeconds(firstCors.maxAge) } : {}),
      },
    },
  ]
}

// ============================================================================
// Type definitions for the Kong subset we emit.
// ============================================================================

type KongPlugin = {
  name: string
  config: Record<string, unknown>
}

type KongRoute = {
  name: string
  methods: string[]
  paths: string[]
  strip_path: boolean
  preserve_host: boolean
  headers?: Record<string, string[]>
  plugins?: KongPlugin[]
}

type KongService = {
  name: string
  protocol: string
  host: string
  port: number
  path?: string
  retries?: number
  read_timeout?: number
  routes: KongRoute[]
}

export type KongConfigShape = {
  _format_version: '3.0'
  _transform: true
  services: KongService[]
  plugins: KongPlugin[]
}
