/**
 * Type layer for fallback bindings.
 *
 * Everything here is type-only or plain data — the package has no runtime
 * dependencies. Zod and @lokalise/api-contracts appear as type-only imports
 * (optional peers); runtime introspection of contracts is structural.
 */
import type { z } from 'zod/v4'

// ============================================================================
// Version handling
// ============================================================================

/** A comparable version: a monotonic number or a comparable string. */
export type Version = number | string

/**
 * Declares how versions are extracted and ordered.
 *
 * The version is the correctness backbone of the fallback pattern: a single
 * "deliver iff newer than the high-watermark" rule handles duplicate delivery
 * (SSE + poll of the same update), the stale-poll race (a slow poll response
 * arriving after a newer pushed event), and replay overlap after reconnect.
 */
export type VersionConfig<Snapshot, Event> =
  | {
      /** Extract the version from a poll snapshot body. */
      ofSnapshot: (snapshot: Snapshot) => Version
      /**
       * Extract the version from a delivered event. The default reads the SSE
       * `id:`, accepting a bare integer (`"42"`) or the
       * `"<numeric epoch>-<counter>"` shape produced by the server-side
       * `createEventIdSequence()`; ids in any other shape (e.g. UUIDs) carry
       * no version. Return `undefined` for events that carry no version —
       * they are delivered without advancing the watermark (at-least-once).
       */
      ofEvent?: (event: Event) => Version | undefined
      /** Custom comparator. Defaults to numeric, falling back to lexicographic. */
      compare?: (a: Version, b: Version) => number
      /**
       * Versions are consecutive integers per subscription scope. Enables
       * client-side gap detection (seq N then N+2 → a repair poll is issued
       * immediately instead of waiting for the deadman timer).
       * @default false
       */
      dense?: boolean
    }
  /**
   * Versionless mode: at-least-once, last-writer-wins. No dedup between
   * channels beyond subscription termination, no gap detection, and the
   * state layer is limited to full snapshot replacement. An adoption bridge
   * for backends without versions — strongly prefer declaring versions.
   */
  | 'none'

// ============================================================================
// Events
// ============================================================================

/** Maps event name → parsed payload type. */
export type EventPayloadMap = Record<string, unknown>

/** An event as delivered to app code, regardless of the channel it used. */
export type FallbackEvent<Events extends EventPayloadMap = EventPayloadMap> = {
  [K in keyof Events & string]: {
    event: K
    data: Events[K]
    /** SSE id when the event arrived over the stream. */
    id?: string
    /**
     * Which channel produced the event. Present for observability — app
     * logic SHOULD ignore it; channel transparency is the whole point.
     */
    origin: FallbackEventOrigin
  }
}[keyof Events & string]

export type FallbackEventOrigin = 'sse' | 'poll'

/** An event synthesized from a snapshot by `snapshotToEvents`. */
export type SyntheticEvent<Events extends EventPayloadMap = EventPayloadMap> = {
  [K in keyof Events & string]: { event: K; data: Events[K] }
}[keyof Events & string]

// ============================================================================
// The binding configuration
// ============================================================================

/**
 * Reconciliation + policy declaration for one dual-mode (or bound-pair)
 * subscription. This is the one thing the framework cannot infer: how a REST
 * snapshot relates to the SSE events. Everything downstream of this
 * declaration — racing, canceling, dedup, reconnect, degradation — is
 * transparent to app code.
 */
export type FallbackBindingConfig<Snapshot, Events extends EventPayloadMap, State = undefined> = {
  /**
   * Translate a poll snapshot into zero or more events, making poll results
   * indistinguishable from pushed events for app code. Must be PURE — a
   * function of the snapshot alone. Return `[]` when the snapshot carries no
   * news (e.g. a job still pending); the poll still advances the watermark.
   *
   * Exactly one of `snapshotToEvents` / `snapshotEvent` is required.
   */
  snapshotToEvents?: (snapshot: Snapshot) => ReadonlyArray<SyntheticEvent<Events>>
  /**
   * Shorthand for the common case where the JSON snapshot body IS the
   * payload of one state-carrying event: expands to
   * `snapshotToEvents: (s) => [{ event: snapshotEvent, data: s }]`.
   */
  snapshotEvent?: keyof Events & string

  /** Version extraction/ordering, or `'none'` (see {@link VersionConfig}). */
  version: VersionConfig<Snapshot, FallbackEvent<Events>>

  /**
   * Events whose delivery completes the subscription (use case: await async
   * completion). Timers are cancelled, in-flight requests aborted, and
   * `events()` iterators complete.
   */
  terminalEvents?: ReadonlyArray<keyof Events & string>

  /**
   * Optional state layer (use case: initial load + hydration). When present,
   * the subscription handle exposes `getState()` / `onStateChange()`.
   * Snapshots REPLACE state via `init`; live events update it via `apply`.
   * Events synthesized from a snapshot are not applied (the snapshot already
   * subsumes them).
   */
  state?: {
    init: (snapshot: Snapshot) => State
    apply: (state: State, event: FallbackEvent<Events>) => State
    /**
     * On gap detection (dense versions): suppress `apply` until the next
     * snapshot re-initializes state, so deltas are never applied out of
     * order. Events still flow to event listeners.
     * @default true
     */
    reinitOnGap?: boolean
  }

  /**
   * Whether the server's Last-Event-ID replay is complete ('trusted') —
   * skipping the reconciliation poll after a reconnect — or best-effort
   * ('untrusted', default) — always polling after the stream reopens.
   * @default 'untrusted'
   */
  replay?: 'trusted' | 'untrusted'

  /** Per-binding policy defaults; overridable per subscription. */
  policy?: Partial<FallbackPolicy>
}

// ============================================================================
// Policy
// ============================================================================

export type BackoffConfig = {
  baseMs: number
  factor: number
  maxMs: number
}

/**
 * A hard ceiling on how long a subscription may keep working before it gives
 * up. Unset by default: a live-state subscription is supposed to run for as
 * long as the surface is open.
 *
 * Set it for pending-completion subscriptions. Every individual wait in this
 * package is bounded, but the subscription as a whole is not: a backend stuck
 * in a pending state deadman-polls forever (backing off to
 * `deadmanIdleBackoff.maxMs`, never giving up), so a permanently pending
 * operation polls until the tab closes. With a budget the subscription stops
 * with a `'budget-exhausted'` reason, which is what a UI needs to show an
 * actionable error and offer a manual retry.
 */
export type SubscriptionBudget = {
  /** Wall-clock ceiling, measured from subscription creation. */
  maxDurationMs?: number
  /** Ceiling on snapshot polls attempted, successful or not. */
  maxPolls?: number
}

export type FallbackPolicy = {
  /**
   * Which channels the subscription uses:
   * - `'dual'` (default): SSE as the low-latency channel, polls as the
   *   correctness backbone, degrading to polling after repeated connect
   *   failures.
   * - `'poll-only'`: never open a stream at all. The subscription starts in
   *   `'polling'` and runs the degraded cadence
   *   (`degradedPollIntervalMs`) from the first tick.
   *
   * `'poll-only'` exists so a backend can adopt this package BEFORE it has an
   * SSE endpoint: the binding, the version gate, the reconciler and the state
   * machine are the same ones the streaming rollout will use, so turning the
   * stream on later is a config change on an already-integrated subscription
   * rather than a second migration. Without it, poll-only delivery is only
   * reachable after `degradedAfterFailures` connect failures against an
   * endpoint that must already exist.
   * @default 'dual'
   */
  mode: 'dual' | 'poll-only'
  /**
   * Overall ceiling for the subscription — see {@link SubscriptionBudget}.
   * Unset by default.
   */
  subscriptionBudget?: SubscriptionBudget
  /**
   * Initial snapshot poll behavior:
   * - `'eager'` (default): fetch a snapshot as soon as the stream opens
   *   (hydration; also closes the startup race where the awaited activity
   *   completed before the stream was established).
   * - `'delayed'`: no initial poll; the first poll happens when the deadman
   *   timer fires.
   * - `'none'`: same as 'delayed' (kept distinct for future use).
   */
  initialPoll: 'eager' | 'delayed' | 'none'
  /**
   * Deadman delay: how long after the last DATA EVENT (heartbeats do not
   * count — they prove transport liveness, not delivery) before a
   * reconciliation poll fires.
   */
  deadmanDelayMs: number
  /** Consecutive no-news polls stretch the deadman interval. */
  deadmanIdleBackoff: { factor: number; maxMs: number }
  /**
   * Force-close the stream when NO BYTES (events, comments, heartbeats)
   * arrive within this window — catches silently dead connections.
   * `'off'` disables byte-level liveness (rely on the deadman alone).
   */
  staleConnectionTimeoutMs: number | 'off'
  /**
   * Abort a stream connect that has not produced response headers within this
   * window, so a hung connect is counted as a connect failure (backoff,
   * degradation) instead of stalling the subscription indefinitely.
   * `'off'` waits forever — only safe with a transport that times out itself.
   */
  connectTimeoutMs: number | 'off'
  /**
   * Abort a snapshot poll that has not settled within this window. Without a
   * bound, one never-settling poll would hold the in-flight latch and leave
   * the deadman unarmed — disabling the correctness backbone entirely.
   * `'off'` waits forever — only safe with a transport that times out itself.
   */
  pollTimeoutMs: number | 'off'
  /** Backoff (full jitter) for failed polls. */
  pollFailureBackoff: BackoffConfig
  /** Backoff (full jitter) for SSE reconnect attempts; `retry:` hints override the base. */
  sseRetryBackoff: BackoffConfig
  /**
   * Bounds applied to a server-sent `retry:` reconnection hint. The hint is
   * attacker- or bug-reachable input: `retry: 0` would spin a zero-delay
   * reconnect loop and a very large value would park reconnection for hours,
   * so it is clamped into this range rather than used verbatim.
   */
  serverRetryHintBounds: { minMs: number; maxMs: number }
  /**
   * Consecutive snapshot-poll failures after which subscribe-first hydration
   * is abandoned: the buffered live events are flushed to the application and
   * the stream resumes delivering directly. Without this, an endpoint that
   * keeps failing its snapshot poll would hold the hydration buffer open and
   * a perfectly healthy stream would deliver nothing.
   */
  hydrationAbandonAfterFailures: number
  /** Consecutive SSE connect failures before degrading to POLLING_ONLY. */
  degradedAfterFailures: number
  /** Poll cadence while degraded (SSE unavailable). */
  degradedPollIntervalMs: number
  /** Cap for background SSE retry while degraded. */
  degradedSseRetryMaxMs: number
  /** Max events buffered during hydration; overflow drops the buffer and refetches. */
  hydrationBufferLimit: number
  /**
   * HTTP statuses on the stream or poll that stop the subscription instead
   * of retrying (auth/authz/not-found are not transient).
   */
  unretryableStatuses: ReadonlyArray<number>
  /**
   * Statuses that are offered to `onAuthChallenge` before the subscription
   * gives up on them. Only meaningful for statuses that are also in
   * {@link unretryableStatuses}.
   *
   * In a SPA a 401 is usually an expired token rather than a genuinely
   * unauthorized caller, and this package exists to recover without a page
   * reload. With an `onAuthChallenge` hook configured, the first auth refusal
   * on either channel is handed to the application, which refreshes
   * credentials and lets the request run once more; a second refusal without
   * an intervening success stops the subscription.
   * @default [401]
   */
  authChallengeStatuses: ReadonlyArray<number>
}

export const DEFAULT_POLICY: FallbackPolicy = {
  mode: 'dual',
  initialPoll: 'eager',
  deadmanDelayMs: 10_000,
  deadmanIdleBackoff: { factor: 1.5, maxMs: 60_000 },
  staleConnectionTimeoutMs: 60_000,
  connectTimeoutMs: 15_000,
  pollTimeoutMs: 10_000,
  pollFailureBackoff: { baseMs: 1_000, factor: 2, maxMs: 30_000 },
  sseRetryBackoff: { baseMs: 1_000, factor: 2, maxMs: 30_000 },
  serverRetryHintBounds: { minMs: 250, maxMs: 60_000 },
  hydrationAbandonAfterFailures: 3,
  degradedAfterFailures: 3,
  degradedPollIntervalMs: 15_000,
  degradedSseRetryMaxMs: 60_000,
  hydrationBufferLimit: 1_000,
  unretryableStatuses: [401, 403, 404],
  authChallengeStatuses: [401],
}

/**
 * Preset for use case A — await async completion.
 *
 * Set `subscriptionBudget` on top of this for operations that must not poll
 * forever if the backend never leaves its pending state.
 */
export const COMPLETION_POLICY: FallbackPolicy = DEFAULT_POLICY

/** Preset for use case B — initial state load + live hydration. */
export const LIVE_STATE_POLICY: FallbackPolicy = {
  ...DEFAULT_POLICY,
  deadmanDelayMs: 120_000,
  deadmanIdleBackoff: { factor: 1.5, maxMs: 300_000 },
  degradedPollIntervalMs: 60_000,
}

/**
 * Preset for adopters with no SSE endpoint yet: same binding, version gate and
 * state machine as the dual-mode presets, polling only. Flip `mode` back to
 * `'dual'` once the stream exists.
 */
export const POLL_ONLY_POLICY: FallbackPolicy = {
  ...DEFAULT_POLICY,
  mode: 'poll-only',
}

// ============================================================================
// Contract type inference (type-only; structural)
// ============================================================================

type SseBodyLike<TSchemas> = { readonly _tag: 'SseBody'; readonly schemaByEventName: TSchemas }

type EventsFromSchemaMap<TSchemas> = {
  [K in keyof TSchemas]: TSchemas[K] extends z.ZodType ? z.output<TSchemas[K]> : never
}

type SseEventsOfContentMap<TContent> = {
  [K in keyof TContent]: TContent[K] extends SseBodyLike<infer TSchemas>
    ? EventsFromSchemaMap<TSchemas>
    : never
}[keyof TContent]

type NonSseBodyOfContentMap<TContent> = {
  [K in keyof TContent]: TContent[K] extends SseBodyLike<unknown>
    ? never
    : TContent[K] extends z.ZodType
      ? z.output<TContent[K]>
      : never
}[keyof TContent]

type SuccessStatusKey = 200 | 201 | 202 | 203 | 206 | 207 | 208 | 226

type SuccessEntries<TContract> = TContract extends {
  responsesByStatusCode: infer TResponses
}
  ? TResponses[Extract<keyof TResponses, SuccessStatusKey>]
  : never

/** Event payload map inferred from a `defineApiContract` contract's sseBody. */
export type InferContractEvents<TContract> = Extract<
  SuccessEntries<TContract> extends infer TEntry
    ? TEntry extends { content: infer TContent }
      ? SseEventsOfContentMap<TContent>
      : never
    : never,
  EventPayloadMap
>

/** Snapshot (non-SSE JSON success body) inferred from a `defineApiContract` contract. */
export type InferContractSnapshot<TContract> =
  SuccessEntries<TContract> extends infer TEntry
    ? TEntry extends { content: infer TContent }
      ? NonSseBodyOfContentMap<TContent>
      : TEntry extends z.ZodType
        ? z.output<TEntry>
        : never
    : never

/** Event payload map inferred from a legacy `buildSseContract` dual-mode contract. */
export type InferLegacyEvents<TContract> = TContract extends {
  serverSentEventSchemas: infer TSchemas
}
  ? EventsFromSchemaMap<TSchemas>
  : never

/** Snapshot inferred from a legacy dual-mode contract's success schema. */
export type InferLegacySnapshot<TContract> = TContract extends {
  successResponseBodySchema: infer TSchema
}
  ? TSchema extends z.ZodType
    ? z.output<TSchema>
    : never
  : never
