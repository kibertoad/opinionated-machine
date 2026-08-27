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

export type EnvoyAdminOptions = {
  /** Bind address; defaults to '0.0.0.0'. */
  address?: string
  /** Bind port (e.g. 9901). */
  port: number
  /** Optional access-log path; omit to skip. */
  accessLogPath?: string
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
  /**
   * Optional HCM-level `stream_idle_timeout` (e.g. `'5m'`, `'0s'` to
   * disable). Envoy's default is 5 minutes. Streaming routes (SSE/dual)
   * override it per route via `idle_timeout` regardless of this setting;
   * this knob controls the listener-wide default for everything else.
   */
  streamIdleTimeout?: string
  /**
   * Ceiling on the total lifetime of a streaming (SSE/dual) connection,
   * emitted as route-level `max_stream_duration`. Defaults to `'30m'`;
   * `'off'` restores unbounded streams. A route can override it with
   * `metadata.timeouts.maxDuration`.
   *
   * Streaming routes disable both the route timeout and the idle timeout
   * (heartbeats are the liveness bound), which without this leaves an
   * undeclared streaming route with an unbounded lifetime. That matters
   * because authorization is checked once, at connect, and then goes stale:
   * a user removed from a project keeps receiving events for as long as the
   * connection lives. A finite lifetime is invisible to users — a client such
   * as `@opinionated-machine/sse-fallback` treats a server close as a routine
   * reconnect (fresh token, `Last-Event-ID`, reconciliation poll) — and gives
   * the platform its re-auth and revocation backstop.
   */
  maxStreamDuration?: string | 'off'
  /**
   * Optional admin listener config. Off by default. When set, Envoy exposes
   * its admin interface (/ready, /stats, /clusters, /config_dump) on the
   * given port — usually 9901 in production deployments.
   */
  admin?: EnvoyAdminOptions
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
  const envoyRoutes = manifest.routes.flatMap((route) =>
    buildRoutes(route, warnings, usedClusters, options),
  )

  // Validate that every referenced cluster has hosts configured. An empty
  // hosts array would render a cluster with no endpoints, making every
  // matching route unroutable at runtime; treat that as a hard error.
  for (const cluster of usedClusters) {
    const clusterOptions = options.clusters[cluster]
    if (!clusterOptions) {
      throw new Error(
        `Manifest references upstream "${cluster}" but no hosts were configured in EnvoyOptions.clusters.`,
      )
    }
    if (clusterOptions.hosts.length === 0) {
      throw new Error(
        `Cluster "${cluster}" was configured with an empty hosts array — every route mapped to this upstream would have no endpoints.`,
      )
    }
  }

  const config: EnvoyConfigShape = {
    ...(options.admin ? { admin: buildAdmin(options.admin) } : {}),
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
                    ...(options.streamIdleTimeout !== undefined
                      ? { stream_idle_timeout: toEnvoyDuration(options.streamIdleTimeout) }
                      : {}),
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

function buildAdmin(opts: EnvoyAdminOptions): EnvoyAdminConfig {
  return {
    ...(opts.accessLogPath ? { access_log_path: opts.accessLogPath } : {}),
    address: {
      socket_address: { address: opts.address ?? '0.0.0.0', port_value: opts.port },
    },
  }
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

/**
 * Build the route action for one BRANCH of a manifest route.
 *
 * `branch` is what this Envoy route actually carries, not what the contract
 * can produce: a dual-mode contract is emitted as two Envoy routes (see
 * {@link buildRoutes}), and the declared timeouts are split between them
 * rather than applied to both. `timeouts.idle` is a stream concern and lands
 * on the stream branch; `timeouts.request` bounds a request/response exchange
 * and lands on the plain branch — applying it to the stream would cap the
 * stream's total lifetime, which is what it does on an SSE-only route (there
 * being no other branch to put it on) and why that case warns.
 */
function buildRouteAction(
  route: GatewayManifestRoute,
  upstream: string,
  branch: 'streaming' | 'plain',
  warnings: string[],
  options: EnvoyOptions,
): EnvoyRouteAction {
  const meta = route.metadata
  const isSplit = route.streaming === 'dual'

  return {
    cluster: upstream,
    ...buildBranchTimeouts(route, branch, isSplit, warnings),
    ...buildMaxStreamDuration(route, branch, options),
    ...(meta.retry ? { retry_policy: buildRetryPolicy(meta.retry) } : {}),
  }
}

const DEFAULT_MAX_STREAM_DURATION = '30m'

/**
 * Bound the total lifetime of a streaming connection.
 *
 * The streaming branch disables both the route timeout and the idle timeout,
 * because heartbeats are its liveness bound. Left there, an undeclared
 * streaming route would have an UNBOUNDED lifetime, and the authorization
 * checked when it connected would stay in force for as long as the process
 * lives. `max_stream_duration` is the ceiling that forces a reconnect, and a
 * reconnect is where a fresh token and a fresh authorization check happen.
 *
 * A generous finite default is safe here precisely because the reconnect is
 * invisible: a client such as `@opinionated-machine/sse-fallback` handles a
 * server close as a routine reconnect with `Last-Event-ID` and a
 * reconciliation poll. Opt out per route with `timeouts.maxDuration: '0s'`,
 * or globally with `EnvoyOptions.maxStreamDuration: 'off'`.
 */
function buildMaxStreamDuration(
  route: GatewayManifestRoute,
  branch: 'streaming' | 'plain',
  options: EnvoyOptions,
): { max_stream_duration?: { max_stream_duration: string } } {
  if (branch !== 'streaming') return {}

  const declared = route.metadata.timeouts?.maxDuration
  const configured = declared ?? options.maxStreamDuration ?? DEFAULT_MAX_STREAM_DURATION
  if (configured === 'off') return {}

  const rendered = toEnvoyDuration(configured)
  // Envoy reads 0s as "no limit", so an explicit zero is the opt-out.
  if (rendered === '0s') return {}

  return { max_stream_duration: { max_stream_duration: rendered } }
}

function buildBranchTimeouts(
  route: GatewayManifestRoute,
  branch: 'streaming' | 'plain',
  isSplit: boolean,
  warnings: string[],
): { timeout?: string; idle_timeout?: string } {
  const timeouts = route.metadata.timeouts

  if (branch === 'streaming') {
    if (timeouts?.request !== undefined && !isSplit) {
      warnings.push(
        `Route "${route.id}": timeouts.request bounds the TOTAL lifetime of a streaming (${route.streaming}) response — long-lived SSE streams are reset when it elapses. Prefer timeouts.idle for streaming routes.`,
      )
    }
    return {
      // Envoy's default route timeout (15s) would reset any stream longer
      // than that. On a split route timeouts.request belongs to the plain
      // branch, so the stream is never bounded by it either.
      timeout:
        isSplit || timeouts?.request === undefined ? '0s' : toEnvoyDuration(timeouts.request),
      // Route-level idle_timeout overrides the HCM stream_idle_timeout
      // (Envoy default: 5m), which would otherwise reset quiet streams.
      // With no declared timeouts.idle we disable it — heartbeats are the
      // intended liveness bound; declare timeouts.idle to reinstate one.
      idle_timeout: timeouts?.idle !== undefined ? toEnvoyDuration(timeouts.idle) : '0s',
    }
  }

  return {
    ...(timeouts?.request !== undefined ? { timeout: toEnvoyDuration(timeouts.request) } : {}),
    // On a split route the declared idle window describes the stream; the
    // plain branch is an ordinary request and keeps the listener default.
    ...(timeouts?.idle !== undefined && !isSplit
      ? { idle_timeout: toEnvoyDuration(timeouts.idle) }
      : {}),
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

/**
 * Header matcher selecting the SSE branch of a dual-mode route.
 *
 * `determineMode()` on the server picks the stream exactly when the client
 * accepts `text/event-stream`, so the same predicate splits the two branches
 * at the gateway. A client that does not ask for the stream explicitly (an
 * `Accept: *\/*` request against a route configured with `defaultMode: 'sse'`)
 * takes the plain branch and its request timeout.
 */
const SSE_ACCEPT_MATCHER: EnvoyHeaderMatcher = {
  name: 'accept',
  string_match: { contains: 'text/event-stream' },
}

/**
 * `text/event-stream` listed with `q=0` — the client naming the type only to
 * REFUSE it. `contains` alone matches that string, so the stream branch would
 * capture a request `determineMode()` routes to JSON.
 *
 * Paired with `invert_match`, this excludes exactly the refusal. Envoy's
 * `safe_regex` uses RE2 (no lookahead) and matches the full header value,
 * hence the leading `.*` and the trailing alternation. `q=0.5` and friends do
 * not match, so a merely deprioritized stream still takes this branch — the
 * same thing `determineMode()` does when nothing outranks it.
 */
const SSE_ACCEPT_NOT_REFUSED_MATCHER: EnvoyHeaderMatcher = {
  name: 'accept',
  string_match: {
    safe_regex: {
      regex: '.*text/event-stream[^,]*;[ \\t]*q[ \\t]*=[ \\t]*0(\\.0+)?[ \\t]*([,;].*)?',
    },
  },
  invert_match: true,
}

/** The Accept matchers that select the SSE branch of a dual-mode route. */
const SSE_BRANCH_MATCHERS: EnvoyHeaderMatcher[] = [
  SSE_ACCEPT_MATCHER,
  SSE_ACCEPT_NOT_REFUSED_MATCHER,
]

/**
 * Accept matchers selecting the JSON branch of a dual-mode route that
 * declares `defaultMode: 'sse'`. There the STREAM is the catch-all, so the
 * JSON branch has to be the narrow one: the client asks for JSON and does not
 * ask for the stream.
 */
const JSON_BRANCH_MATCHERS: EnvoyHeaderMatcher[] = [
  { name: 'accept', string_match: { contains: 'application/json' } },
  { name: 'accept', string_match: { contains: 'text/event-stream' }, invert_match: true },
]

/**
 * Emit the Envoy routes for one manifest route.
 *
 * SSE-only and plain routes map one-to-one. A **dual-mode** route maps to
 * TWO: one matching an `Accept: text/event-stream` request with stream-shaped
 * timeouts, and one catch-all keeping ordinary request/response bounds.
 * A single route cannot do both — disabling the route and idle timeouts is
 * required for the stream and strips every bound from the JSON poll branch
 * that the fallback client leans on, which is the branch most in need of one.
 */
function buildRoutes(
  route: GatewayManifestRoute,
  warnings: string[],
  usedClusters: Set<string>,
  options: EnvoyOptions,
): EnvoyRoute[] {
  const meta = route.metadata
  if (!meta.upstream) {
    throw new Error(
      `Route "${route.id}" has no upstream — set metadata.upstream on the route or controller defaults.`,
    )
  }
  usedClusters.add(meta.upstream)

  collectUnsupportedWarnings(route.id, meta, warnings)

  if (route.streaming !== 'dual') {
    return [
      buildRoute(route, meta.upstream, {
        branch: route.streaming === 'sse' ? 'streaming' : 'plain',
        warnings,
        options,
      }),
    ]
  }

  // Which branch the catch-all is depends on the route's own fallback. With
  // `defaultMode: 'json'` (the default) an unspecific Accept header gets JSON,
  // so the stream is the narrow branch. With `defaultMode: 'sse'` the server
  // streams for a missing or wildcard Accept header, and routing those through
  // the plain branch would put a request timeout on a live stream.
  if (route.streamingDefaultMode === 'sse') {
    warnings.push(
      `Route "${route.id}": defaultMode "sse" makes the STREAM the catch-all branch, so only an explicit application/json Accept (without text/event-stream) takes the JSON branch. A request listing both types resolves to JSON on the server but takes the stream branch here, and so runs without the JSON branch's request timeout.`,
    )
    return [
      buildRoute(route, meta.upstream, {
        branch: 'plain',
        name: `${route.id}__json`,
        extraHeaderMatchers: JSON_BRANCH_MATCHERS,
        warnings,
        options,
      }),
      buildRoute(route, meta.upstream, {
        branch: 'streaming',
        name: `${route.id}__sse`,
        warnings,
        options,
      }),
    ]
  }

  // Order matters: Envoy takes the first matching route, so the narrower
  // Accept-matched stream branch must precede the catch-all.
  return [
    buildRoute(route, meta.upstream, {
      branch: 'streaming',
      name: `${route.id}__sse`,
      extraHeaderMatchers: SSE_BRANCH_MATCHERS,
      warnings,
      options,
    }),
    buildRoute(route, meta.upstream, { branch: 'plain', warnings, options }),
  ]
}

function buildRoute(
  route: GatewayManifestRoute,
  upstream: string,
  opts: {
    branch: 'streaming' | 'plain'
    name?: string
    extraHeaderMatchers?: EnvoyHeaderMatcher[]
    warnings: string[]
    options: EnvoyOptions
  },
): EnvoyRoute {
  const meta = route.metadata
  const headerMatchers = [
    ...collectHeaderMatchers(route.method, meta),
    ...(opts.extraHeaderMatchers ?? []),
  ]
  const queryMatchers = collectQueryMatchers(meta)

  const r: EnvoyRoute = {
    name: opts.name ?? route.id,
    match: {
      safe_regex: { regex: openApiPathToEnvoyRegex(route.path) },
      ...(headerMatchers.length > 0 ? { headers: headerMatchers } : {}),
      ...(queryMatchers.length > 0 ? { query_parameters: queryMatchers } : {}),
    },
    route: buildRouteAction(route, upstream, opts.branch, opts.warnings, opts.options),
    ...buildRouteHeaderRules(meta),
  }

  // Vendor-specific extension: deep-merge the envoy escape hatch onto the
  // generated route. Shallow assignment would let common patterns like
  // `extensions.envoy.route = { regex_rewrite: {...} }` clobber the entire
  // generated `route` object (including cluster, timeout, retry_policy);
  // we merge nested objects recursively instead.
  const envoyExt = meta.extensions?.envoy as Record<string, unknown> | undefined
  if (envoyExt) {
    deepMergeInto(r as Record<string, unknown>, envoyExt)
  }

  return r
}

function deepMergeInto(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    const existing = target[key]
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      existing &&
      typeof existing === 'object' &&
      !Array.isArray(existing)
    ) {
      deepMergeInto(existing as Record<string, unknown>, value as Record<string, unknown>)
    } else {
      target[key] = value
    }
  }
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

type EnvoyStringMatch =
  | { exact: string }
  | { prefix: string }
  | { contains: string }
  | { safe_regex: { regex: string } }

type EnvoyHeaderMatcher = {
  name: string
  string_match: EnvoyStringMatch
  /** Negate the match, so the route requires the header NOT to match. */
  invert_match?: boolean
}
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
  idle_timeout?: string
  max_stream_duration?: { max_stream_duration: string }
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

type EnvoyAdminConfig = {
  access_log_path?: string
  address: { socket_address: { address: string; port_value: number } }
}

export type EnvoyConfigShape = {
  admin?: EnvoyAdminConfig
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
