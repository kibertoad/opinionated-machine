import { createSSEStreamParser } from '@opinionated-machine/sse-parser'
import type { FallbackBinding, FallbackRequestParams } from './binding.ts'
import type { EventPayloadMap, FallbackEvent, FallbackPolicy } from './bindingTypes.ts'
import { DEFAULT_POLICY } from './bindingTypes.ts'
import type { PollGate } from './pollGate.ts'
import type { VersionGap } from './reconciler.ts'
import { Reconciler } from './reconciler.ts'
import { backoffDelay, ResettableTimer, sleep } from './scheduler.ts'
import type { FallbackTransport, ParsedSseFrame, StreamResponse } from './transport.ts'
import { isParsedStreamResponse } from './transport.ts'

// ============================================================================
// Public types
// ============================================================================

export type SubscriptionStatus = 'connecting' | 'live' | 'reconnecting' | 'polling' | 'stopped'

/**
 * Why a subscription reached `'stopped'`.
 *
 * `'stopped'` alone cannot be acted on: a completed job, an auth failure and a
 * caller's own `stop()` all land there. The reason is what lets a UI tell
 * success from give-up, and give-up from "the user navigated away".
 *
 * - `'terminal-event'` — a terminal event was delivered. Success.
 * - `'unretryable-status'` — the stream or a poll was refused with a status in
 *   `unretryableStatuses` (and `onAuthChallenge`, if any, did not recover).
 *   `status` carries which one.
 * - `'budget-exhausted'` — `subscriptionBudget` ran out. `limit` says which
 *   half. Show an actionable error and offer a manual retry.
 * - `'manual'` — the caller called `stop()`, or the `signal` passed at
 *   creation aborted.
 */
export type StopReason = 'terminal-event' | 'unretryable-status' | 'budget-exhausted' | 'manual'

/** The reason a subscription stopped, plus whatever detail that reason carries. */
export type SubscriptionStopDetail = {
  reason: StopReason
  /** The refusing HTTP status, for `'unretryable-status'`. */
  status?: number
  /** Which half of the budget ran out, for `'budget-exhausted'`. */
  limit?: 'maxDurationMs' | 'maxPolls'
  /** Which channel hit the refusal, for `'unretryable-status'`. */
  channel?: 'poll' | 'stream'
}

/**
 * Rejection thrown by `waitFor` / `waitForTerminal` when the subscription
 * stops before the awaited event arrives. Carries the stop reason so the
 * caller can branch without inspecting the message.
 */
export class SubscriptionStoppedError extends Error {
  readonly reason: StopReason
  readonly status: number | undefined
  readonly limit: 'maxDurationMs' | 'maxPolls' | undefined
  readonly channel: 'poll' | 'stream' | undefined

  constructor(detail: SubscriptionStopDetail) {
    super(`Subscription stopped (${detail.reason}) before the awaited event arrived`)
    this.name = 'SubscriptionStoppedError'
    this.reason = detail.reason
    this.status = detail.status
    this.limit = detail.limit
    this.channel = detail.channel
  }
}

/**
 * Observability hooks — all optional, all no-ops by default. None of these
 * affect delivery semantics; they exist so applications can meter the
 * fallback machinery (gap rate, duplicate rate, poll errors).
 */
export type FallbackDiagnostics = {
  onGap?: (gap: VersionGap) => void
  onDuplicate?: (event: string) => void
  onStaleSnapshot?: () => void
  onPollError?: (error: unknown) => void
  onStreamError?: (error: unknown) => void
  /**
   * A gap suspended the state layer: `getState()` is frozen at its pre-gap
   * value until a snapshot repairs it, even though events keep flowing.
   */
  onStateSuspended?: (gap: VersionGap) => void
  /** A snapshot lifted the suspension and re-initialized state. */
  onStateRepaired?: () => void
  /** A listener passed to `onEvent` / `onStateChange` / `onStatusChange` threw. */
  onListenerError?: (error: unknown) => void
}

export type CreateResilientSubscriptionOptions = {
  transport: FallbackTransport
  params?: FallbackRequestParams
  policy?: Partial<FallbackPolicy>
  diagnostics?: FallbackDiagnostics
  signal?: AbortSignal
  /**
   * Shared cap and stagger for reconciliation polls across subscriptions —
   * see `createPollGate`. Without one, a fleet-wide reconnect fires every
   * subscription's reconciliation poll on the same tick.
   */
  pollGate?: PollGate
  /**
   * Called when a poll or stream connect is refused with a status in
   * `policy.authChallengeStatuses` (default `[401]`). Refresh credentials
   * here — the transport builds every request fresh, so a token stored on the
   * transport is picked up by the retry.
   *
   * Resolve `true` to run the refused request once more; resolve `false`, or
   * throw, to stop the subscription with `'unretryable-status'`. The retry is
   * granted once per auth failure streak: a second refusal with no successful
   * request in between stops the subscription.
   */
  onAuthChallenge?: (challenge: {
    status: number
    channel: 'poll' | 'stream'
  }) => boolean | Promise<boolean>
  /**
   * Decode an SSE `data:` payload into the value handed to the reconciler.
   * Defaults to `JSON.parse`, matching the framework's default serializer.
   * Routes that configure a custom `serializer` (or send raw strings) declare
   * the matching decoder here — otherwise their frames cannot be read, and a
   * frame that cannot be read is a lost event, repaired by a poll.
   */
  parseEventData?: (raw: string) => unknown
  /** Injectable randomness for deterministic backoff in tests. */
  random?: () => number
}

export type ResilientSubscription<
  Events extends EventPayloadMap = EventPayloadMap,
  State = undefined,
> = {
  /** Uniform event stream — SSE-pushed, replayed, and poll-synthesized alike. */
  events(): AsyncIterable<FallbackEvent<Events>>
  /** Callback-style event consumption; returns an unsubscribe function. */
  onEvent(listener: (event: FallbackEvent<Events>) => void): () => void
  /** Latest reduced state — only meaningful when the binding declares `state`. */
  getState(): State | undefined
  onStateChange(listener: (state: State) => void): () => void
  readonly status: SubscriptionStatus
  /**
   * Observe status transitions. `detail` is present exactly when `status` is
   * `'stopped'`, and says why — see {@link StopReason}.
   */
  onStatusChange(
    listener: (status: SubscriptionStatus, detail?: SubscriptionStopDetail) => void,
  ): () => void
  /**
   * Why the subscription stopped, or `undefined` while it is still running.
   * Also delivered to `onStop` and `onStatusChange` at the moment it stops.
   */
  readonly result: SubscriptionStopDetail | undefined
  /**
   * Run a listener when the subscription stops. Registering after it has
   * already stopped calls the listener immediately, so there is no race
   * between subscribing and a terminal event that arrived first.
   */
  onStop(listener: (detail: SubscriptionStopDetail) => void): () => void
  /** Force an immediate reconciliation poll + connection check. */
  nudge(): void
  /** Stop the subscription: cancel timers, abort in-flight requests. */
  stop(): void
  /**
   * Await the first delivery of a specific event (use case: await async
   * completion). Resolves identically whether the event traveled over SSE,
   * replay, or a fallback poll.
   *
   * Rejects with {@link SubscriptionStoppedError} if the subscription stops
   * first, so the caller can tell an auth failure from an exhausted budget.
   */
  waitFor<K extends keyof Events & string>(
    event: K,
    opts?: { timeoutMs?: number },
  ): Promise<Events[K]>
  /** Await the first terminal event (any of the binding's terminalEvents). */
  waitForTerminal(opts?: { timeoutMs?: number }): Promise<FallbackEvent<Events>>
}

// ============================================================================
// Implementation
// ============================================================================

type IteratorFeed<Events extends EventPayloadMap> = {
  push: (event: FallbackEvent<Events>) => void
  finish: () => void
}

class ResilientSubscriptionImpl<Snapshot, Events extends EventPayloadMap, State> {
  private readonly binding: FallbackBinding<Snapshot, Events, State>
  private readonly transport: FallbackTransport
  private readonly params: FallbackRequestParams
  private readonly policy: FallbackPolicy
  private readonly diagnostics: FallbackDiagnostics
  private readonly random: () => number
  private readonly parseEventData: (raw: string) => unknown
  private readonly reconciler: Reconciler<Snapshot, Events, State>
  private readonly pollGate: PollGate | undefined
  private readonly onAuthChallenge:
    | ((challenge: { status: number; channel: 'poll' | 'stream' }) => boolean | Promise<boolean>)
    | undefined

  private readonly abortController = new AbortController()
  private currentStreamAbort: AbortController | undefined

  private statusValue: SubscriptionStatus = 'connecting'
  private stopped = false
  private stopDetail: SubscriptionStopDetail | undefined
  private streamConnected = false
  private lastEventId: string | undefined
  /**
   * The credential refresh currently running, shared by both channels so a
   * poll and a reconnect refused by the same expired token recover together.
   */
  private authRefresh: Promise<boolean> | undefined
  private serverRetryHintMs: number | undefined
  private consecutiveConnectFailures = 0
  private degraded = false
  /** Whether the current stream has produced any bytes at all. */
  private streamProducedBytes = false

  private pollInFlight = false
  private pollQueued = false
  private pollFailures = 0
  private idlePolls = 0
  /** Polls attempted, for `subscriptionBudget.maxPolls`. */
  private pollsAttempted = 0
  /** Whether the one auth retry has been spent since the last successful request. */
  private authRetrySpent = false

  private readonly deadman = new ResettableTimer(() => this.schedulePoll())
  private readonly staleConnection = new ResettableTimer(() => this.onStaleConnection())
  private readonly budgetTimer = new ResettableTimer(() =>
    this.stopWith({ reason: 'budget-exhausted', limit: 'maxDurationMs' }),
  )

  private readonly eventListeners = new Set<(event: FallbackEvent<Events>) => void>()
  private readonly stateListeners = new Set<(state: State) => void>()
  private readonly statusListeners = new Set<
    (status: SubscriptionStatus, detail?: SubscriptionStopDetail) => void
  >()
  private readonly stopListeners = new Set<(detail: SubscriptionStopDetail) => void>()
  private readonly iteratorFeeds = new Set<IteratorFeed<Events>>()

  constructor(
    binding: FallbackBinding<Snapshot, Events, State>,
    options: CreateResilientSubscriptionOptions,
  ) {
    this.binding = binding
    this.transport = options.transport
    this.params = options.params ?? {}
    this.policy = { ...DEFAULT_POLICY, ...binding.config.policy, ...options.policy }
    this.diagnostics = options.diagnostics ?? {}
    this.random = options.random ?? Math.random
    this.parseEventData = options.parseEventData ?? JSON.parse
    this.pollGate = options.pollGate
    this.onAuthChallenge = options.onAuthChallenge
    this.reconciler = new Reconciler(binding.config, {
      hydrationBufferLimit: this.policy.hydrationBufferLimit,
    })

    if (options.signal) {
      if (options.signal.aborted) {
        this.stop()
        return
      }
      options.signal.addEventListener('abort', () => this.stop(), { once: true })
    }

    const maxDurationMs = this.policy.subscriptionBudget?.maxDurationMs
    if (maxDurationMs !== undefined) {
      this.budgetTimer.arm(maxDurationMs)
    }

    if (this.policy.mode === 'poll-only') {
      // No stream is ever opened, so the machine starts where a dual-mode
      // subscription only lands after repeated connect failures.
      this.degraded = true
      this.setStatus('polling')
      if (this.policy.initialPoll === 'eager') {
        this.schedulePoll()
      } else {
        this.armDeadman()
      }
      return
    }

    void this.runStreamLoop()
    if (this.policy.initialPoll !== 'eager') {
      // No hydration poll — the deadman provides the fallback cadence.
      this.armDeadman()
    }
  }

  // --------------------------------------------------------------------
  // Public surface
  // --------------------------------------------------------------------

  get status(): SubscriptionStatus {
    return this.statusValue
  }

  get result(): SubscriptionStopDetail | undefined {
    return this.stopDetail
  }

  getState(): State | undefined {
    return this.reconciler.getState()
  }

  onEvent(listener: (event: FallbackEvent<Events>) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  onStateChange(listener: (state: State) => void): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  onStatusChange(
    listener: (status: SubscriptionStatus, detail?: SubscriptionStopDetail) => void,
  ): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  onStop(listener: (detail: SubscriptionStopDetail) => void): () => void {
    if (this.stopDetail !== undefined) {
      this.runListener(listener, this.stopDetail)
      return () => {}
    }
    this.stopListeners.add(listener)
    return () => this.stopListeners.delete(listener)
  }

  events(): AsyncIterable<FallbackEvent<Events>> {
    const queue: Array<FallbackEvent<Events>> = []
    let notify: (() => void) | undefined
    let done = this.stopped

    const feed: IteratorFeed<Events> = {
      push: (event) => {
        queue.push(event)
        notify?.()
      },
      finish: () => {
        done = true
        notify?.()
      },
    }
    this.iteratorFeeds.add(feed)

    const feeds = this.iteratorFeeds
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<FallbackEvent<Events>>> {
            while (true) {
              const item = queue.shift()
              if (item !== undefined) return { value: item, done: false }
              if (done) {
                feeds.delete(feed)
                return { value: undefined, done: true }
              }
              await new Promise<void>((resolve) => {
                notify = resolve
              })
              notify = undefined
            }
          },
          return(): Promise<IteratorResult<FallbackEvent<Events>>> {
            feeds.delete(feed)
            done = true
            return Promise.resolve({ value: undefined, done: true })
          },
        }
      },
    }
  }

  waitFor<K extends keyof Events & string>(
    event: K,
    opts?: { timeoutMs?: number },
  ): Promise<Events[K]> {
    return this.waitMatching((delivered) => delivered.event === event, opts).then(
      (delivered) => delivered.data as Events[K],
    )
  }

  waitForTerminal(opts?: { timeoutMs?: number }): Promise<FallbackEvent<Events>> {
    const terminal = new Set(this.binding.config.terminalEvents ?? [])
    return this.waitMatching((delivered) => terminal.has(delivered.event), opts)
  }

  nudge(): void {
    if (this.stopped) return
    this.schedulePoll()
    // If the stream looks dead, force a reconnect check too.
    if (this.streamConnected && this.policy.staleConnectionTimeoutMs !== 'off') {
      // Byte-activity watchdog stays authoritative; nothing else to do here.
      return
    }
  }

  stop(): void {
    this.stopWith({ reason: 'manual' })
  }

  private stopWith(detail: SubscriptionStopDetail): void {
    if (this.stopped) return
    this.stopped = true
    this.stopDetail = detail
    this.deadman.clear()
    this.staleConnection.clear()
    this.budgetTimer.clear()
    this.currentStreamAbort?.abort()
    this.abortController.abort()
    this.setStatus('stopped', detail)
    for (const listener of this.stopListeners) this.runListener(listener, detail)
    this.stopListeners.clear()
    for (const feed of this.iteratorFeeds) feed.finish()
    this.iteratorFeeds.clear()
  }

  // --------------------------------------------------------------------
  // Stream loop
  // --------------------------------------------------------------------

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the connect/consume/reconnect loop is a single state machine — splitting it would obscure the transitions
  private async runStreamLoop(): Promise<void> {
    let firstConnect = true
    while (!this.stopped) {
      const streamAbort = new AbortController()
      this.currentStreamAbort = streamAbort
      const onMasterAbort = () => streamAbort.abort()
      this.abortController.signal.addEventListener('abort', onMasterAbort, { once: true })

      let connectFailed = false
      this.streamProducedBytes = false
      // A connect that never produces headers must not park the subscription:
      // bound it here so it fails like any other connect failure (backoff,
      // degradation, fallback polling) instead of hanging forever.
      const connectTimeout = new ResettableTimer(() => streamAbort.abort())
      if (this.policy.connectTimeoutMs !== 'off') {
        connectTimeout.arm(this.policy.connectTimeoutMs)
      }
      try {
        const response = await this.transport.openStream(
          this.binding.buildStreamRequest(this.params),
          { signal: streamAbort.signal, lastEventId: this.lastEventId },
        )
        connectTimeout.clear()
        if (this.stopped) return

        const contentType = response.headers['content-type'] ?? ''
        if (
          response.status !== 200 ||
          (contentType && !contentType.includes('text/event-stream'))
        ) {
          connectFailed = true
          // Abort the request so the rejected response body is released — the
          // chunks of a refused connect are never consumed, and without this
          // every retry would leak a socket.
          streamAbort.abort()
          this.diagnostics.onStreamError?.(
            new Error(`SSE connect failed with status ${response.status}`),
          )
          if (this.policy.unretryableStatuses.includes(response.status)) {
            // An expired token is the common case behind a 401 in a SPA, and
            // recovering without a page reload is the point of this package.
            // Give the application one chance to refresh credentials; the
            // reconnect below then retries with them.
            const recovered = await this.tryAuthChallenge(response.status, 'stream')
            if (this.stopped) return
            if (!recovered) {
              this.stopWith({
                reason: 'unretryable-status',
                status: response.status,
                channel: 'stream',
              })
              return
            }
          }
        } else {
          this.serverRetryHintMs = undefined

          if (firstConnect) {
            if (this.policy.initialPoll === 'eager') {
              // Subscribe-first hydration: buffer live events until the
              // snapshot lands — zero missed-event window.
              this.reconciler.beginHydration()
              this.schedulePoll()
            } else {
              this.setStatus('live')
            }
          } else {
            // While degraded, an accepted connect is not evidence of anything:
            // only bytes downgrade the status back out of 'polling'.
            if (!this.degraded) {
              this.setStatus('live')
            }
            if ((this.binding.config.replay ?? 'untrusted') === 'untrusted') {
              // Events during the outage are lost unless the server replays
              // them completely — reconcile via a poll.
              this.schedulePoll()
            }
          }
          firstConnect = false

          this.armStaleConnection()
          await this.consumeStream(response)
          connectTimeout.clear()
          if (this.stopped || this.reconciler.isTerminated) return
          // Stream ended (server close, stale-abort, or network) — fall
          // through to the reconnect path.
        }
      } catch (error) {
        if (this.stopped) return
        connectFailed = !this.streamConnected
        this.diagnostics.onStreamError?.(error)
      } finally {
        connectTimeout.clear()
        this.staleConnection.clear()
        this.streamConnected = false
        this.abortController.signal.removeEventListener('abort', onMasterAbort)
      }

      if (this.stopped || this.reconciler.isTerminated) return

      // A connection only counts as successful once it has actually carried
      // bytes. A stream that is accepted and then closes immediately would
      // otherwise reset the backoff on every attempt and never degrade,
      // turning a broken upstream into a reconnect-and-poll storm.
      if (connectFailed || !this.streamProducedBytes) {
        this.consecutiveConnectFailures += 1
      }
      if (this.consecutiveConnectFailures >= this.policy.degradedAfterFailures) {
        if (!this.degraded) {
          this.degraded = true
          this.setStatus('polling')
          // Degraded cadence applies from the next deadman arm.
          this.armDeadman()
        }
      } else {
        this.setStatus('reconnecting')
      }

      // The stream just dropped — data may have been lost; poll now.
      this.schedulePoll()

      const backoffConfig = this.degraded
        ? { ...this.policy.sseRetryBackoff, maxMs: this.policy.degradedSseRetryMaxMs }
        : this.policy.sseRetryBackoff
      const delay =
        this.serverRetryHintMs !== undefined && !connectFailed
          ? this.serverRetryHintMs
          : backoffDelay(backoffConfig, this.consecutiveConnectFailures, this.random)
      const proceed = await sleep(delay, this.abortController.signal)
      if (!proceed) return
    }
  }

  private consumeStream(response: StreamResponse): Promise<void> {
    this.streamConnected = true
    return isParsedStreamResponse(response)
      ? this.consumeFrames(response.events)
      : this.consumeChunks(response.chunks)
  }

  /** Whether the loop should stop pulling from the stream. */
  private get streamLoopDone(): boolean {
    return this.stopped || this.reconciler.isTerminated
  }

  /**
   * Consume a transport that already framed the stream. Comment/heartbeat
   * frames were consumed before they reached us, so liveness here is
   * event-level, not byte-level — see `ParsedStreamResponse` for what that
   * costs.
   */
  private async consumeFrames(frames: AsyncIterable<ParsedSseFrame>): Promise<void> {
    for await (const frame of frames) {
      if (this.streamLoopDone) return
      this.onStreamActivity()
      void this.handleParsedEvent(frame)
      if (this.streamLoopDone) return
    }
  }

  /** Consume raw text and do the SSE framing here. */
  private async consumeChunks(chunks: AsyncIterable<string>): Promise<void> {
    // The parser owns the partial-frame buffer and its own cursor, which is
    // NOT `this.lastEventId`: an event whose data fails to parse holds that
    // one back, and the parser knows nothing about that.
    const parser = createSSEStreamParser({ lastEventId: this.lastEventId })
    for await (const chunk of chunks) {
      if (this.streamLoopDone) return
      // ANY bytes (heartbeat comments included) prove transport liveness.
      this.onStreamActivity()
      let cursorHeld = false
      for (const event of parser.push(chunk)) {
        if (!this.handleParsedEvent(event)) cursorHeld = true
        if (this.streamLoopDone) return
      }
      // An `id:` frame carrying no data still moves the reconnect cursor, and
      // an empty `id:` clears it, so the cursor comes from the parser rather
      // than from the events it emitted. A frame this batch could not read
      // holds it where it was.
      if (!cursorHeld) this.lastEventId = parser.lastEventId
    }
  }

  /** Called for every unit of stream activity — a raw chunk or a parsed frame. */
  private onStreamActivity(): void {
    this.armStaleConnection()
    if (this.streamProducedBytes) return
    this.streamProducedBytes = true
    // The stream is demonstrably working — clear the failure history and
    // leave degraded mode. Doing this here rather than at connect keeps a
    // connect-then-close loop counted as the failure it is.
    this.consecutiveConnectFailures = 0
    this.authRetrySpent = false
    this.degraded = false
    // Bytes on the wire are the only evidence that delivery works, so they are
    // what promotes the subscription to 'live' — from degraded polling, and
    // equally from the 'connecting' a byte-less stream is parked in after
    // hydration was abandoned. Hydration itself still owns the status until it
    // finishes, so a busy stream cannot announce 'live' before the snapshot
    // it is buffering behind has landed.
    if (!this.reconciler.isHydrating) {
      this.setStatus('live')
    }
  }

  /**
   * Move the reconnect cursor to where this frame leaves it.
   *
   * The parser tracks Last-Event-ID across frames, so an event with no `id:`
   * of its own still reports the cursor it inherited and an empty `id:` clears
   * it. A transport that framed the stream itself reports no cursor, so there
   * the id the frame carried is all there is.
   */
  private advanceEventCursor(parsed: ParsedSseFrame): void {
    if (parsed.lastEventId !== undefined) {
      this.lastEventId = parsed.lastEventId
      return
    }
    if (parsed.id !== undefined && parsed.id !== '') this.lastEventId = parsed.id
  }

  /**
   * Feed one framed SSE event through the reconciler.
   *
   * @returns `false` when the frame was unreadable, so the caller keeps the
   *   reconnect cursor where it was.
   */
  private handleParsedEvent(parsed: ParsedSseFrame): boolean {
    if (parsed.retry !== undefined && Number.isFinite(parsed.retry)) {
      const { minMs, maxMs } = this.policy.serverRetryHintBounds
      this.serverRetryHintMs = Math.min(Math.max(parsed.retry, minMs), maxMs)
    }

    let data: unknown
    try {
      data = this.parseEventData(parsed.data)
    } catch (error) {
      // The frame is unreadable, so the event it carried is lost. Poll to
      // repair it, and leave `lastEventId` where it was — advancing past an
      // event that was never delivered would make a Last-Event-ID replay skip
      // it for good.
      this.diagnostics.onStreamError?.(error)
      this.schedulePoll()
      return false
    }

    this.advanceEventCursor(parsed)

    // A data event (not a heartbeat) — reset the deadman. Not while
    // hydrating: there the deadman is the retry timer for the snapshot the
    // buffered events are waiting on, and a busy stream would push it out
    // indefinitely.
    if (!this.reconciler.isHydrating) {
      this.idlePolls = 0
      this.armDeadman()
    }

    const outcome = this.reconciler.handleEvent({
      event: parsed.event ?? 'message',
      data,
      ...(parsed.id !== undefined ? { id: parsed.id } : {}),
    })
    if (outcome.duplicate) {
      this.diagnostics.onDuplicate?.(parsed.event ?? 'message')
    }
    if (outcome.bufferOverflow) {
      // Hydration buffer overflowed — drop-and-refetch.
      this.schedulePoll()
    }
    if (outcome.gap) {
      this.diagnostics.onGap?.(outcome.gap)
      if (outcome.stateSuspended) {
        // getState() is frozen at its pre-gap value from here until a snapshot
        // repairs it, while events keep flowing to listeners.
        this.diagnostics.onStateSuspended?.(outcome.gap)
      }
      // A gap is a loss, not a reorder — polling is the only repair.
      this.schedulePoll()
    }
    this.deliver(outcome.deliveries, outcome.state)
    if (outcome.terminated) {
      this.stopWith({ reason: 'terminal-event' })
    }
    return true
  }

  private onStaleConnection(): void {
    // No bytes at all within the window: the connection is silently dead
    // (the original incident class). Force-close; the stream loop reconnects
    // and polls immediately.
    this.currentStreamAbort?.abort()
  }

  private armStaleConnection(): void {
    if (this.policy.staleConnectionTimeoutMs === 'off') return
    this.staleConnection.arm(this.policy.staleConnectionTimeoutMs)
  }

  // --------------------------------------------------------------------
  // Polling
  // --------------------------------------------------------------------

  private schedulePoll(): void {
    if (this.stopped || this.reconciler.isTerminated) return
    if (this.pollInFlight) {
      this.pollQueued = true
      return
    }
    void this.executePoll()
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: poll execution coordinates gating, status transitions, failure backoff, and coalescing in one place
  private async executePoll(): Promise<void> {
    const maxPolls = this.policy.subscriptionBudget?.maxPolls
    if (maxPolls !== undefined && this.pollsAttempted >= maxPolls) {
      this.stopWith({ reason: 'budget-exhausted', limit: 'maxPolls' })
      return
    }
    this.pollsAttempted += 1
    this.pollInFlight = true
    // Polling is the correctness backbone, so a poll that never settles is
    // the worst failure this machine has: it would hold the in-flight latch
    // and leave the deadman unarmed, silently disabling every future poll.
    // Bound it, and let the timeout land in the failure path below.
    const pollAbort = new AbortController()
    const onMasterAbort = () => pollAbort.abort()
    this.abortController.signal.addEventListener('abort', onMasterAbort, { once: true })
    const pollTimeout = new ResettableTimer(() => pollAbort.abort())
    if (this.policy.pollTimeoutMs !== 'off') {
      pollTimeout.arm(this.policy.pollTimeoutMs)
    }
    // A shared gate caps and staggers reconciliation polls across every
    // subscription in the tab, so one server blip does not turn into a
    // simultaneous burst of one poll per subscription.
    let releaseGate: (() => void) | undefined
    try {
      if (this.pollGate) {
        releaseGate = await this.pollGate.acquire({ signal: pollAbort.signal })
        if (this.stopped || this.reconciler.isTerminated) return
      }
      const response = await this.transport.fetchSnapshot(
        this.binding.buildSnapshotRequest(this.params),
        { signal: pollAbort.signal },
      )
      if (this.stopped || this.reconciler.isTerminated) return

      if (response.status < 200 || response.status >= 300) {
        this.diagnostics.onPollError?.(
          new Error(`Snapshot poll failed with status ${response.status}`),
        )
        if (this.policy.unretryableStatuses.includes(response.status)) {
          const recovered = await this.tryAuthChallenge(response.status, 'poll')
          if (this.stopped || this.reconciler.isTerminated) return
          if (!recovered) {
            this.stopWith({
              reason: 'unretryable-status',
              status: response.status,
              channel: 'poll',
            })
            return
          }
          // Credentials were refreshed — run the refused poll once more. The
          // finally block below releases the latch and starts it.
          this.pollQueued = true
          return
        }
        this.onPollFailed()
        return
      }

      this.pollFailures = 0
      this.authRetrySpent = false
      const outcome = this.reconciler.handleSnapshot(response.body as Snapshot)
      if (outcome.stale) {
        this.diagnostics.onStaleSnapshot?.()
      }
      if (outcome.stateRepaired) {
        this.diagnostics.onStateRepaired?.()
      }
      this.deliver(outcome.deliveries, outcome.state)
      if (outcome.hydrationCompleted && !this.stopped) {
        // Hydration can complete while 'connecting' (normal startup) or
        // 'polling' (first successful connect after starting degraded).
        this.setStatus(this.streamConnected ? 'live' : this.degraded ? 'polling' : 'reconnecting')
      }
      if (outcome.terminated) {
        this.stopWith({ reason: 'terminal-event' })
        return
      }

      if (outcome.deliveries.length > 0) {
        this.idlePolls = 0
      } else {
        this.idlePolls += 1
      }
      this.armDeadman()
    } catch (error) {
      if (this.stopped) return
      this.diagnostics.onPollError?.(error)
      this.onPollFailed()
    } finally {
      releaseGate?.()
      pollTimeout.clear()
      this.abortController.signal.removeEventListener('abort', onMasterAbort)
      this.pollInFlight = false
      if (this.pollQueued && !this.stopped && !this.reconciler.isTerminated) {
        this.pollQueued = false
        void this.executePoll()
      }
    }
  }

  /**
   * Offer an auth refusal to the application once, so an expired token can be
   * refreshed instead of killing the subscription.
   *
   * Returns `true` when the caller refreshed credentials and the refused
   * request should run again. The retry is spent until a request succeeds, so
   * a hook that keeps returning `true` against a genuinely unauthorized caller
   * cannot spin.
   */
  private async tryAuthChallenge(status: number, channel: 'poll' | 'stream'): Promise<boolean> {
    const onAuthChallenge = this.onAuthChallenge
    if (!onAuthChallenge) return false
    if (!this.policy.authChallengeStatuses.includes(status)) return false

    // Both channels see the same expired token, so a refusal that arrives
    // while a refresh is running is the SAME failure, not a second one:
    // it waits for that refresh and retries with the credentials it produced.
    // Spending the retry here instead would kill the subscription mid-refresh.
    const inFlight = this.authRefresh
    if (inFlight) return await inFlight

    if (this.authRetrySpent) return false
    this.authRetrySpent = true
    const refresh = (async () => {
      try {
        return (await onAuthChallenge({ status, channel })) === true
      } catch (error) {
        this.diagnostics.onListenerError?.(error)
        return false
      }
    })()
    this.authRefresh = refresh
    try {
      return await refresh
    } finally {
      // Only a refusal AFTER this refresh completed counts as the second
      // failure, which is what `authRetrySpent` now gates.
      if (this.authRefresh === refresh) this.authRefresh = undefined
    }
  }

  /**
   * Common tail for a failed poll: back off, and stop holding back live
   * events once the snapshot endpoint has failed often enough that waiting
   * for it is worse than delivering what the stream already gave us.
   */
  private onPollFailed(): void {
    this.pollFailures += 1
    this.deadman.arm(backoffDelay(this.policy.pollFailureBackoff, this.pollFailures, this.random))

    if (
      this.reconciler.isHydrating &&
      this.pollFailures >= this.policy.hydrationAbandonAfterFailures
    ) {
      const outcome = this.reconciler.abandonHydration()
      this.deliver(outcome.deliveries, outcome.state)
      this.setStatus(this.statusAfterAbandonedHydration())
      if (outcome.terminated) this.stopWith({ reason: 'terminal-event' })
    }
  }

  /**
   * Status to report once subscribe-first hydration is abandoned.
   *
   * `streamConnected` is set before the first chunk arrives, so it cannot
   * stand in for "delivery is healthy": hydration is abandoned precisely
   * because polls kept failing, and if the stream has been silent too then
   * nothing has been delivered at all. Only actual bytes earn `'live'` —
   * which is the same rule the byte-based recovery in `onStreamActivity` uses.
   */
  private statusAfterAbandonedHydration(): SubscriptionStatus {
    if (this.streamProducedBytes) return 'live'
    if (this.degraded) return 'polling'
    return this.streamConnected ? 'connecting' : 'reconnecting'
  }

  private armDeadman(): void {
    if (this.stopped || this.reconciler.isTerminated) return
    if (this.degraded) {
      this.deadman.arm(this.policy.degradedPollIntervalMs)
      return
    }
    const { factor, maxMs } = this.policy.deadmanIdleBackoff
    const delay = Math.min(this.policy.deadmanDelayMs * factor ** this.idlePolls, maxMs)
    this.deadman.arm(delay)
  }

  // --------------------------------------------------------------------
  // Delivery + listeners
  // --------------------------------------------------------------------

  private deliver(
    deliveries: ReadonlyArray<FallbackEvent<Events>>,
    state: { value: unknown } | undefined,
  ): void {
    for (const event of deliveries) {
      for (const listener of this.eventListeners) this.runListener(listener, event)
      for (const feed of this.iteratorFeeds) feed.push(event)
    }
    if (state !== undefined) {
      for (const listener of this.stateListeners) this.runListener(listener, state.value as State)
    }
  }

  /**
   * Call one application listener in isolation.
   *
   * A throwing listener used to take down the whole delivery: the remaining
   * event listeners, every `events()` iterator and the state listeners were
   * skipped, and the exception unwound into the stream or poll loop, where it
   * was recorded as a transport failure. An application bug then degraded the
   * connection it had nothing to do with. Listener faults are reported through
   * `diagnostics.onListenerError` and go no further.
   */
  private runListener<T>(listener: (value: T) => void, value: T): void {
    try {
      listener(value)
    } catch (error) {
      try {
        this.diagnostics.onListenerError?.(error)
      } catch {
        // A diagnostics hook that throws too is not allowed to escape either.
      }
    }
  }

  private setStatus(status: SubscriptionStatus, detail?: SubscriptionStopDetail): void {
    if (this.statusValue === status) return
    this.statusValue = status
    for (const listener of this.statusListeners) {
      this.runListener(() => listener(status, detail), undefined)
    }
  }

  private waitMatching(
    matches: (event: FallbackEvent<Events>) => boolean,
    opts?: { timeoutMs?: number },
  ): Promise<FallbackEvent<Events>> {
    return new Promise((resolve, reject) => {
      if (this.stopped) {
        reject(new SubscriptionStoppedError(this.stopDetail ?? { reason: 'manual' }))
        return
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      const offStatus = this.onStatusChange((status, detail) => {
        if (status === 'stopped') {
          cleanup()
          reject(new SubscriptionStoppedError(detail ?? { reason: 'manual' }))
        }
      })
      const offEvent = this.onEvent((event) => {
        if (!matches(event)) return
        cleanup()
        resolve(event)
      })
      const cleanup = () => {
        offEvent()
        offStatus()
        if (timer !== undefined) clearTimeout(timer)
      }
      if (opts?.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          cleanup()
          reject(new Error(`Timed out after ${opts.timeoutMs}ms waiting for event`))
        }, opts.timeoutMs)
        ;(timer as { unref?: () => void }).unref?.()
      }
    })
  }
}

/**
 * Create a resilient subscription: SSE as the low-latency channel, short
 * polls as the correctness backbone. See the package README for the state
 * machine and reconciliation semantics.
 */
export function createResilientSubscription<
  Snapshot,
  Events extends EventPayloadMap,
  State = undefined,
>(
  binding: FallbackBinding<Snapshot, Events, State>,
  options: CreateResilientSubscriptionOptions,
): ResilientSubscription<Events, State> {
  const impl = new ResilientSubscriptionImpl(binding, options)
  return {
    events: () => impl.events(),
    onEvent: (listener) => impl.onEvent(listener),
    getState: () => impl.getState(),
    onStateChange: (listener) => impl.onStateChange(listener),
    get status() {
      return impl.status
    },
    onStatusChange: (listener) => impl.onStatusChange(listener),
    get result() {
      return impl.result
    },
    onStop: (listener) => impl.onStop(listener),
    nudge: () => impl.nudge(),
    stop: () => impl.stop(),
    waitFor: (event, opts) => impl.waitFor(event, opts),
    waitForTerminal: (opts) => impl.waitForTerminal(opts),
  }
}
