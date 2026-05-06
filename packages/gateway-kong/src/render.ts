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

/**
 * Which Kong distribution the rendered config targets.
 *
 * - `'oss'` (default): Kong Gateway OSS / Community Edition. Enterprise-only
 *   plugins are not emitted; metadata that needs them produces a warning.
 * - `'enterprise'`: Kong Gateway Enterprise. Enables plugins that are not
 *   available in OSS (e.g. `mtls-auth`).
 */
export type KongProfile = 'oss' | 'enterprise'

export type KongOptions = {
  /** Map from `metadata.upstream` to the upstream URL Kong should proxy to. */
  upstreams: Record<string, KongUpstreamOptions>
  /** Distribution to target. Default: `'oss'`. */
  profile?: KongProfile
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
 * plugins. Set `options.profile = 'enterprise'` to additionally emit plugins
 * that only exist in Kong Gateway Enterprise (e.g. `mtls-auth`).
 */
export function renderKongConfig(
  manifest: GatewayManifest,
  options: KongOptions,
): RenderKongResult {
  const warnings: string[] = []
  const profile: KongProfile = options.profile ?? 'oss'

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
    services.push(buildService(upstreamName, upstreamOpts, routes, profile, warnings))
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
  profile: KongProfile,
  warnings: string[],
): KongService {
  const url = new URL(upstreamOpts.url)
  // Kong CE's read_timeout is service-level — every route under this service
  // inherits the same value, so we use the LOOSEST timeout among the routes.
  // Routes that asked for a tighter timeout get a warning so the operator
  // knows to enforce it elsewhere (a Lua plugin, a sidecar, the upstream).
  const readTimeout = pickLoosestTimeout(routes)
  for (const route of routes) {
    const declared = route.metadata.timeouts?.request
    if (!declared) continue
    const declaredMs = toMilliseconds(declared)
    if (readTimeout !== undefined && declaredMs < readTimeout) {
      warnings.push(
        `Route "${route.id}": metadata.timeouts.request (${declared}) is tighter than the service-level read_timeout (${readTimeout}ms) — Kong CE has no per-route timeout override; enforce this at the upstream or via a Lua plugin.`,
      )
    }
  }

  return {
    name,
    protocol: url.protocol.replace(':', ''),
    host: url.hostname,
    port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80,
    path: url.pathname === '/' ? undefined : url.pathname,
    ...(upstreamOpts.retries !== undefined ? { retries: upstreamOpts.retries } : {}),
    ...(readTimeout !== undefined ? { read_timeout: readTimeout } : {}),
    routes: routes
      .map((route) => buildRoute(route, profile, warnings))
      .sort((a, b) => a.name.localeCompare(b.name)),
  }
}

function pickLoosestTimeout(routes: GatewayManifest['routes']): number | undefined {
  let loosest: number | undefined
  for (const route of routes) {
    const timeout = route.metadata.timeouts?.request
    if (!timeout) continue
    const ms = toMilliseconds(timeout)
    if (loosest === undefined || ms > loosest) loosest = ms
  }
  return loosest
}

function buildRoute(
  route: GatewayManifest['routes'][number],
  profile: KongProfile,
  warnings: string[],
): KongRoute {
  const meta = route.metadata
  const headers = collectHeaderMatchers(meta)
  const kongPath = openApiPathToKong(route.path)
  const stripPath = meta.rewrite?.stripPrefix !== undefined

  // Kong's strip_path strips the entire matched route path. For regex paths
  // (anything we authored with {param}), that strips the captured params too —
  // almost never what the user wrote rewrite.stripPrefix to do. Warn loudly.
  if (stripPath && kongPath.startsWith('~')) {
    warnings.push(
      `Route "${route.id}": metadata.rewrite.stripPrefix on a parameterised path doesn't translate cleanly to Kong's strip_path — Kong will strip the entire matched path, including captured params. Consider request-transformer with a custom rewrite, or restructure the upstream URL.`,
    )
  }
  if (meta.rewrite?.replacePrefix) {
    warnings.push(
      `Route "${route.id}": metadata.rewrite.replacePrefix is not modelled — use a request-transformer plugin via extensions.kong_plugins, or restructure the upstream URL.`,
    )
  }

  const r: KongRoute = {
    name: route.id,
    methods: [route.method],
    paths: [kongPath],
    strip_path: stripPath,
    preserve_host: false,
    ...(headers ? { headers } : {}),
    plugins: collectRoutePlugins(route.id, meta, profile, warnings),
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
  profile: KongProfile,
  warnings: string[],
): KongPlugin[] {
  const plugins: KongPlugin[] = []

  if (meta.rateLimit) plugins.push(buildRateLimitPlugin(meta.rateLimit))
  if (meta.cache?.ttl) plugins.push(buildCachePlugin(meta.cache))
  if (meta.auth?.jwt) plugins.push(buildJwtPlugin())
  plugins.push(...buildTransformerPlugins(meta.headers))

  // mTLS — first-class only in Enterprise via the mtls-auth plugin.
  if (meta.auth?.mTLS && profile === 'enterprise') {
    plugins.push({ name: 'mtls-auth', config: {} })
  }

  collectRouteWarnings(routeId, meta, profile, warnings)

  // Vendor escape hatch: meta.extensions.kong_plugins (array) is appended.
  const extPlugins = (meta.extensions?.kong_plugins as KongPlugin[] | undefined) ?? []
  plugins.push(...extPlugins)

  return plugins
}

function collectRouteWarnings(
  routeId: string,
  meta: GatewayMetadataValue,
  profile: KongProfile,
  warnings: string[],
): void {
  if (meta.auth?.mTLS && profile !== 'enterprise') {
    warnings.push(
      `Route "${routeId}": metadata.auth.mTLS requires Kong Enterprise's mtls-auth plugin — pass options.profile = 'enterprise', or terminate mTLS at the listener in front of Kong.`,
    )
  }
  if (meta.circuitBreaker) {
    warnings.push(
      profile === 'enterprise'
        ? `Route "${routeId}": metadata.circuitBreaker has no first-class Kong plugin even in Enterprise — wire connectivity governance via a service-mesh layer or extensions.kong_plugins.`
        : `Route "${routeId}": metadata.circuitBreaker has no native equivalent in Kong OSS — consider Kong Enterprise or a service-mesh layer.`,
    )
  }
  if (meta.traffic?.weights || meta.traffic?.shadow) {
    warnings.push(
      `Route "${routeId}": metadata.traffic (weighted / shadow) is not modelled — configure Kong upstreams + targets manually if needed.`,
    )
  }
  if (meta.match?.host) {
    warnings.push(
      `Route "${routeId}": metadata.match.host is not modelled — use the Kong route's hosts attribute via extensions.kong.`,
    )
  }
  if (meta.match?.query || meta.match?.customQuery) {
    warnings.push(
      `Route "${routeId}": metadata.match.query / customQuery has no native Kong route matcher — wire it via a request-validator plugin.`,
    )
  }
  if (meta.auth?.required && !meta.auth.jwt && !meta.auth.mTLS) {
    warnings.push(
      `Route "${routeId}": metadata.auth.required without auth.jwt / auth.mTLS has no automatic mapping — attach a Kong auth plugin (key-auth, basic-auth, oauth2) via extensions.kong_plugins.`,
    )
  }
}

function buildRateLimitPlugin(
  rateLimit: NonNullable<GatewayMetadataValue['rateLimit']>,
): KongPlugin {
  const seconds = toSeconds(rateLimit.per)
  // Bucket selection — Kong's rate-limiting plugin takes per-second / minute
  // / hour / day counts; pick the smallest bucket the window fits in.
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
