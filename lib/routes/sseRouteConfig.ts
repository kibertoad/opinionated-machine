/**
 * Translation layer between framework-level SSE route options and the
 * per-route `sse` field understood by @fastify/sse 0.6.
 *
 * @fastify/sse 0.6 introduced route "kinds" that control Accept-header
 * negotiation, and reduced per-route heartbeat control to an on/off switch
 * (`heartbeat: false`) — the interval itself is plugin-level only. The
 * framework therefore:
 * - picks the kind per route flavor ('only' for SSE-only routes, 'manual'
 *   for dual-mode routes where `determineMode()` owns Accept negotiation),
 * - disables the plugin heartbeat whenever a route-level interval is
 *   configured and runs its own timer instead (see sseHeartbeat.ts).
 */

/**
 * The @fastify/sse route kinds the framework emits.
 *
 * - `'only'` — SSE-only route. Lenient Accept gate: any spec-compliant
 *   Accept header (including `*`/`*` or a missing header) admits SSE;
 *   clients that explicitly refuse `text/event-stream` get a 406.
 * - `'manual'` — no plugin-side Accept negotiation; `reply.sse` is always
 *   attached and the framework's `determineMode()` decides sync vs SSE.
 *   Used for dual-mode routes.
 * - `'dual'` — plugin-side strict gate with handler fallback. Not currently
 *   emitted (it would bypass `determineMode()`s q-value parsing and
 *   `defaultMode` semantics), listed for completeness.
 */
export type SSERouteKind = 'only' | 'dual' | 'manual'

/**
 * Object form of the @fastify/sse 0.6 per-route `sse` field as emitted by
 * the framework. `heartbeat: false` disables the plugin's own heartbeat
 * timer (the framework timer takes over when an interval is configured).
 */
export type SSERouteFieldObject = {
  kind: SSERouteKind
  heartbeat?: false
  serializer?: (data: unknown) => string
}

/** The per-route `sse` field: a bare kind or the object form. */
export type SSERouteField = SSERouteKind | SSERouteFieldObject

/**
 * Framework-level SSE options relevant to the route `sse` field.
 */
export type FrameworkSSERouteOptions = {
  /** Custom serializer for SSE data on this route (honored by the plugin). */
  serializer?: (data: unknown) => string
  /**
   * Route-level heartbeat interval in milliseconds.
   * A number enables the framework-managed heartbeat timer at that interval;
   * `0` or `false` disables heartbeats for the route entirely.
   * When set (either way), the plugin's own heartbeat is turned off.
   */
  heartbeatInterval?: number | false
}

/**
 * Build the per-route `sse` field for @fastify/sse 0.6.
 *
 * Returns the bare kind when no route-level serializer/heartbeat options are
 * present; otherwise the object form with `heartbeat: false` whenever a
 * route-level interval (or explicit disable) is configured.
 */
export function buildSSERouteField(
  kind: SSERouteKind,
  options?: FrameworkSSERouteOptions,
): SSERouteField {
  if (!options?.serializer && options?.heartbeatInterval === undefined) {
    return kind
  }

  const field: SSERouteFieldObject = { kind }
  if (options.serializer) {
    field.serializer = options.serializer
  }
  if (options.heartbeatInterval !== undefined) {
    // The plugin can only switch its heartbeat off per route; the framework
    // timer (sseHeartbeat.ts) handles numeric intervals.
    field.heartbeat = false
  }
  return field
}

/**
 * Merge registration-time overrides (RegisterSSERoutesOptions /
 * RegisterDualModeRoutesOptions) into an already-built route's `sse` field.
 *
 * Route-level values win: a serializer already present on the field is kept,
 * and `heartbeat: false` is only added (never removed).
 */
export function mergeSSERouteField(
  existing: unknown,
  patch: {
    serializer?: (data: unknown) => string
    disablePluginHeartbeat?: boolean
  },
): SSERouteField {
  const base: SSERouteFieldObject =
    typeof existing === 'string'
      ? { kind: existing as SSERouteKind }
      : existing && typeof existing === 'object'
        ? { ...(existing as SSERouteFieldObject) }
        : // `true` (legacy) or missing — preserve legacy negotiation by omitting `kind`
          ({} as SSERouteFieldObject)

  if (patch.serializer && !base.serializer) {
    base.serializer = patch.serializer
  }
  if (patch.disablePluginHeartbeat) {
    base.heartbeat = false
  }
  return base
}
