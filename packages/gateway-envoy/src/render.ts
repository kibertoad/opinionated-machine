import type {
  GatewayManifest,
  GatewayManifestRoute,
  GatewayMetadataValue,
  MatchRule,
} from 'opinionated-machine'
import { stringify as stringifyYaml } from 'yaml'
import { toEnvoyDuration } from './durations.ts'
import { openApiPathToEnvoyRegex } from './pathMatch.ts'

export type EnvoyClusterOptions = {
  /** Resolved hostnames (or `host:port`) that the cluster proxies to. */
  hosts: string[]
  /** Optional connect timeout for the cluster. Defaults to 1s. */
  connectTimeout?: string
}

export type EnvoyOptions = {
  /** Listener port (Envoy's HCM listens on 0.0.0.0:<listenPort>). */
  listenPort: number
  /** Map from `metadata.upstream` to actual cluster hosts. */
  clusters: Record<string, EnvoyClusterOptions>
  /** Optional name for the listener; defaults to "listener_0". */
  listenerName?: string
  /** Optional name for the route_config; defaults to "<service>_routes". */
  routeConfigName?: string
}

export type RenderEnvoyResult = {
  yaml: string
  json: EnvoyConfigShape
  warnings: string[]
}

/**
 * Render an Envoy v3 static bootstrap config from a gateway manifest.
 *
 * Maps a curated subset of universal metadata fields. Anything we can't
 * express (e.g. `cache.ttl` — Envoy needs an external HTTP cache filter) is
 * reported as a warning rather than silently dropped.
 */
export function renderEnvoyConfig(
  manifest: GatewayManifest,
  options: EnvoyOptions,
): RenderEnvoyResult {
  const warnings: string[] = []
  const usedClusters = new Set<string>()
  const envoyRoutes = manifest.routes.map((route) => buildRoute(route, warnings, usedClusters))

  // Validate that every referenced cluster has hosts configured.
  for (const cluster of usedClusters) {
    if (!options.clusters[cluster]) {
      throw new Error(
        `Manifest references upstream "${cluster}" but no hosts were configured in EnvoyOptions.clusters.`,
      )
    }
  }

  const config: EnvoyConfigShape = {
    static_resources: {
      listeners: [
        {
          name: options.listenerName ?? 'listener_0',
          address: {
            socket_address: { address: '0.0.0.0', port_value: options.listenPort },
          },
          filter_chains: [
            {
              filters: [
                {
                  name: 'envoy.filters.network.http_connection_manager',
                  typed_config: {
                    '@type':
                      'type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager',
                    stat_prefix: manifest.service,
                    route_config: {
                      name: options.routeConfigName ?? `${manifest.service}_routes`,
                      virtual_hosts: [
                        {
                          name: manifest.service,
                          domains: ['*'],
                          routes: envoyRoutes,
                        },
                      ],
                    },
                    http_filters: [
                      { name: 'envoy.filters.http.router', typed_config: ROUTER_CONFIG },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
      clusters: Array.from(usedClusters)
        .sort()
        .map((name) => buildCluster(name, options.clusters[name] as EnvoyClusterOptions)),
    },
  }

  return {
    yaml: stringifyYaml(config, { indent: 2 }),
    json: config,
    warnings,
  }
}

const ROUTER_CONFIG = {
  '@type': 'type.googleapis.com/envoy.extensions.filters.http.router.v3.Router',
}

type UnsupportedFieldWarning = {
  detail: string
  /** Returns true if the metadata triggers this warning. */
  triggers: (meta: GatewayMetadataValue) => boolean
}

const UNSUPPORTED_FIELDS: Array<{ name: string } & UnsupportedFieldWarning> = [
  {
    name: 'cache',
    triggers: (m) => m.cache !== undefined,
    detail:
      'Envoy needs the http_cache filter wired into the listener — set extensions.envoy on the route to attach typed_per_filter_config.',
  },
  {
    name: 'circuitBreaker',
    triggers: (m) => m.circuitBreaker !== undefined,
    detail:
      'applies at the cluster level (cluster.circuit_breakers.thresholds[]) — set it via extensions.envoy on a representative route or configure the cluster manually.',
  },
  {
    name: 'auth.jwt',
    triggers: (m) => m.auth?.jwt !== undefined,
    detail:
      'wire envoy.filters.http.jwt_authn into the listener and reference the provider via extensions.envoy.typed_per_filter_config.',
  },
  {
    name: 'auth.required (without auth.jwt)',
    triggers: (m) => Boolean(m.auth?.required) && !m.auth?.jwt,
    detail:
      'has no automatic Envoy mapping — wire an authn filter (jwt_authn, ext_authz) on the listener.',
  },
  {
    name: 'auth.mTLS',
    triggers: (m) => Boolean(m.auth?.mTLS),
    detail:
      'mTLS is configured at the listener / transport socket — set it on the listener, not per route.',
  },
  {
    name: 'cors',
    triggers: (m) => m.cors !== undefined,
    detail:
      'wire envoy.filters.http.cors into the listener and attach typed_per_filter_config via extensions.envoy.',
  },
  {
    name: 'rateLimit',
    triggers: (m) => m.rateLimit !== undefined,
    detail:
      'wire envoy.filters.http.local_ratelimit and attach the per-route policy via extensions.envoy.typed_per_filter_config.',
  },
  {
    name: 'traffic.weights',
    triggers: (m) => Array.isArray(m.traffic?.weights) && m.traffic.weights.length > 0,
    detail:
      'use envoy weighted_clusters — set it explicitly via extensions.envoy.route.weighted_clusters.',
  },
  {
    name: 'traffic.shadow',
    triggers: (m) => m.traffic?.shadow !== undefined,
    detail:
      'use envoy request_mirror_policies — set it via extensions.envoy.route.request_mirror_policies.',
  },
  {
    name: 'match.host',
    triggers: (m) => m.match?.host !== undefined,
    detail:
      'host routing belongs at the virtual_host level (domains) rather than per route — configure it on the listener.',
  },
  {
    name: 'rewrite',
    triggers: (m) => m.rewrite?.stripPrefix !== undefined || m.rewrite?.replacePrefix !== undefined,
    detail:
      'envoy needs regex_rewrite for our parameterised paths (prefix_rewrite only works with prefix matchers) — set it explicitly via extensions.envoy.route.regex_rewrite.',
  },
]

function collectUnsupportedWarnings(
  routeId: string,
  meta: GatewayMetadataValue,
  warnings: string[],
): void {
  for (const { name, triggers, detail } of UNSUPPORTED_FIELDS) {
    if (triggers(meta)) {
      warnings.push(`Route "${routeId}": metadata.${name} is not mapped — ${detail}`)
    }
  }
}

function buildRouteAction(meta: GatewayMetadataValue, upstream: string): EnvoyRouteAction {
  return {
    cluster: upstream,
    ...(meta.timeouts?.request !== undefined
      ? { timeout: toEnvoyDuration(meta.timeouts.request) }
      : {}),
    ...(meta.retry ? { retry_policy: buildRetryPolicy(meta.retry) } : {}),
  }
}

function buildRouteHeaderRules(meta: GatewayMetadataValue): {
  request_headers_to_add?: EnvoyHeaderAddition[]
  request_headers_to_remove?: string[]
  response_headers_to_add?: EnvoyHeaderAddition[]
  response_headers_to_remove?: string[]
} {
  const requestHeadersToAdd = collectHeaderAdditions(meta.headers?.request?.add)
  const responseHeadersToAdd = collectHeaderAdditions(meta.headers?.response?.add)
  return {
    ...(requestHeadersToAdd.length > 0 ? { request_headers_to_add: requestHeadersToAdd } : {}),
    ...(meta.headers?.request?.remove?.length
      ? { request_headers_to_remove: meta.headers.request.remove }
      : {}),
    ...(responseHeadersToAdd.length > 0 ? { response_headers_to_add: responseHeadersToAdd } : {}),
    ...(meta.headers?.response?.remove?.length
      ? { response_headers_to_remove: meta.headers.response.remove }
      : {}),
  }
}

function buildRoute(
  route: GatewayManifestRoute,
  warnings: string[],
  usedClusters: Set<string>,
): EnvoyRoute {
  const meta = route.metadata
  if (!meta.upstream) {
    throw new Error(
      `Route "${route.id}" has no upstream — set metadata.upstream on the route or controller defaults.`,
    )
  }
  usedClusters.add(meta.upstream)

  collectUnsupportedWarnings(route.id, meta, warnings)

  const headerMatchers = collectHeaderMatchers(route.method, meta)
  const queryMatchers = collectQueryMatchers(meta)

  const r: EnvoyRoute = {
    name: route.id,
    match: {
      safe_regex: { regex: openApiPathToEnvoyRegex(route.path) },
      ...(headerMatchers.length > 0 ? { headers: headerMatchers } : {}),
      ...(queryMatchers.length > 0 ? { query_parameters: queryMatchers } : {}),
    },
    route: buildRouteAction(meta, meta.upstream),
    ...buildRouteHeaderRules(meta),
  }

  // Vendor-specific extension: deep-merge envoy escape hatch into the route at the end.
  const envoyExt = meta.extensions?.envoy as Record<string, unknown> | undefined
  if (envoyExt) {
    Object.assign(r, envoyExt)
  }

  return r
}

function buildCluster(name: string, opts: EnvoyClusterOptions): EnvoyCluster {
  return {
    name,
    type: 'STRICT_DNS',
    connect_timeout: toEnvoyDuration(opts.connectTimeout ?? '1s'),
    load_assignment: {
      cluster_name: name,
      endpoints: [
        {
          lb_endpoints: opts.hosts.map((host) => {
            const [address, portStr] = host.split(':')
            return {
              endpoint: {
                address: {
                  socket_address: {
                    address: address as string,
                    port_value: portStr ? Number(portStr) : 80,
                  },
                },
              },
            }
          }),
        },
      ],
    },
  }
}

function buildRetryPolicy(retry: NonNullable<GatewayMetadataValue['retry']>): EnvoyRetryPolicy {
  // The retry-condition vocabulary already matches Envoy's retry_on values
  // (5xx, gateway-error, connect-failure, reset, retriable-4xx) so they
  // pass through as a CSV.
  return {
    ...(retry.attempts !== undefined ? { num_retries: retry.attempts } : {}),
    ...(retry.on?.length ? { retry_on: retry.on.join(',') } : {}),
    ...(retry.perTryTimeout ? { per_try_timeout: toEnvoyDuration(retry.perTryTimeout) } : {}),
  }
}

function collectHeaderMatchers(method: string, meta: GatewayMetadataValue): EnvoyHeaderMatcher[] {
  const matchers: EnvoyHeaderMatcher[] = [{ name: ':method', string_match: { exact: method } }]
  const headers = { ...(meta.match?.headers ?? {}), ...(meta.match?.customHeaders ?? {}) }
  for (const [name, rule] of Object.entries(headers)) {
    matchers.push({ name, string_match: matchRuleToEnvoy(rule) })
  }
  return matchers
}

function collectQueryMatchers(meta: GatewayMetadataValue): EnvoyQueryMatcher[] {
  const merged = { ...(meta.match?.query ?? {}), ...(meta.match?.customQuery ?? {}) }
  return Object.entries(merged).map(([name, rule]) => ({
    name,
    string_match: matchRuleToEnvoy(rule),
  }))
}

function matchRuleToEnvoy(rule: MatchRule): EnvoyStringMatch {
  if (typeof rule === 'string') return { exact: rule }
  if ('exact' in rule) return { exact: rule.exact }
  if ('prefix' in rule) return { prefix: rule.prefix }
  return { safe_regex: { regex: rule.regex } }
}

function collectHeaderAdditions(add: Record<string, string> | undefined): EnvoyHeaderAddition[] {
  if (!add) return []
  return Object.entries(add).map(([key, value]) => ({
    header: { key, value },
  }))
}

// ============================================================================
// Type definitions for the Envoy bootstrap subset we emit. Kept narrow on
// purpose — we don't try to model all of envoy.config.v3, only what we render.
// ============================================================================

type EnvoyStringMatch = { exact: string } | { prefix: string } | { safe_regex: { regex: string } }

type EnvoyHeaderMatcher = { name: string; string_match: EnvoyStringMatch }
type EnvoyQueryMatcher = { name: string; string_match: EnvoyStringMatch }

type EnvoyHeaderAddition = { header: { key: string; value: string } }

type EnvoyRetryPolicy = {
  num_retries?: number
  retry_on?: string
  per_try_timeout?: string
}

type EnvoyRouteAction = {
  cluster: string
  timeout?: string
  prefix_rewrite?: string
  retry_policy?: EnvoyRetryPolicy
}

type EnvoyRoute = {
  name: string
  match: {
    safe_regex: { regex: string }
    headers?: EnvoyHeaderMatcher[]
    query_parameters?: EnvoyQueryMatcher[]
  }
  route: EnvoyRouteAction
  request_headers_to_add?: EnvoyHeaderAddition[]
  request_headers_to_remove?: string[]
  response_headers_to_add?: EnvoyHeaderAddition[]
  response_headers_to_remove?: string[]
}

type EnvoyCluster = {
  name: string
  type: 'STRICT_DNS'
  connect_timeout: string
  load_assignment: {
    cluster_name: string
    endpoints: Array<{
      lb_endpoints: Array<{
        endpoint: {
          address: { socket_address: { address: string; port_value: number } }
        }
      }>
    }>
  }
}

export type EnvoyConfigShape = {
  static_resources: {
    listeners: Array<{
      name: string
      address: { socket_address: { address: string; port_value: number } }
      filter_chains: Array<{
        filters: Array<{
          name: string
          typed_config: Record<string, unknown>
        }>
      }>
    }>
    clusters: EnvoyCluster[]
  }
}
