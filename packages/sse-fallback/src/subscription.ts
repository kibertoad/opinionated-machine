import type { FallbackBinding, FallbackRequestParams } from './binding.ts'
import type { EventPayloadMap, FallbackEvent, FallbackPolicy, Version } from './bindingTypes.ts'
import { DEFAULT_POLICY } from './bindingTypes.ts'
import { Reconciler } from './reconciler.ts'
import { backoffDelay, ResettableTimer, sleep } from './scheduler.ts'
import { parseSSEBuffer } from './sseParser.ts'
import type { FallbackTransport } from './transport.ts'

// ============================================================================
// Public types
// ============================================================================

export type SubscriptionStatus = 'connecting' | 'live' | 'reconnecting' | 'polling' | 'stopped'

/**
 * Observability hooks — all optional, all no-ops by default. None of these
 * affect delivery semantics; they exist so applications can meter the
 * fallback machinery (gap rate, duplicate rate, poll errors).
 */
export type FallbackDiagnostics = {
  onGap?: (gap: { from: Version; to: Version }) => void
  onDuplicate?: (event: string) => void
  onStaleSnapshot?: () => void
  onPollError?: (error: unknown) => void
  onStreamError?: (error: unknown) => void
}

export type CreateResilientSubscriptionOptions = {
  transport: FallbackTransport
  params?: FallbackRequestParams
  policy?: Partial<FallbackPolicy>
  diagnostics?: FallbackDiagnostics
  signal?: AbortSignal
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
  onStatusChange(listener: (status: SubscriptionStatus) => void): () => void
  /** Force an immediate reconciliation poll + connection check. */
  nudge(): void
  /** Stop the subscription: cancel timers, abort in-flight requests. */
  stop(): void
  /**
   * Await the first delivery of a specific event (use case: await async
   * completion). Resolves identically whether the event traveled over SSE,
   * replay, or a fallback poll.
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

  private readonly abortController = new AbortController()
  private currentStreamAbort: AbortController | undefined

  private statusValue: SubscriptionStatus = 'connecting'
  private stopped = false
  private streamConnected = false
  private lastEventId: string | undefined
  private serverRetryHintMs: number | undefined
  private consecutiveConnectFailures = 0
  private degraded = false
  /** Whether the current stream has produced any bytes at all. */
  private streamProducedBytes = false

  private pollInFlight = false
  private pollQueued = false
  private pollFailures = 0
  private idlePolls = 0

  private readonly deadman = new ResettableTimer(() => this.schedulePoll())
  private readonly staleConnection = new ResettableTimer(() => this.onStaleConnection())

  private readonly eventListeners = new Set<(event: FallbackEvent<Events>) => void>()
  private readonly stateListeners = new Set<(state: State) => void>()
  private readonly statusListeners = new Set<(status: SubscriptionStatus) => void>()
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

  onStatusChange(listener: (status: SubscriptionStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
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
    if (this.stopped) return
    this.stopped = true
    this.deadman.clear()
    this.staleConnection.clear()
    this.currentStreamAbort?.abort()
    this.abortController.abort()
    this.setStatus('stopped')
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
            this.stop()
            return
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
          await this.consumeStream(response.chunks)
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

  private async consumeStream(chunks: AsyncIterable<string>): Promise<void> {
    this.streamConnected = true
    let buffer = ''
    for await (const chunk of chunks) {
      if (this.stopped || this.reconciler.isTerminated) return
      // ANY bytes (heartbeat comments included) prove transport liveness.
      this.armStaleConnection()
      if (!this.streamProducedBytes) {
        this.streamProducedBytes = true
        // The stream is demonstrably working — clear the failure history and
        // leave degraded mode. Doing this here rather than at connect keeps a
        // connect-then-close loop counted as the failure it is.
        this.consecutiveConnectFailures = 0
        if (this.degraded) {
          this.degraded = false
          this.setStatus('live')
        }
      }
      buffer += chunk
      const parsed = parseSSEBuffer(buffer)
      buffer = parsed.remaining
      for (const event of parsed.events) {
        this.handleParsedEvent(event)
        if (this.stopped || this.reconciler.isTerminated) return
      }
    }
  }

  private handleParsedEvent(parsed: {
    id?: string
    event?: string
    data: string
    retry?: number
  }): void {
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
      return
    }

    if (parsed.id !== undefined && parsed.id !== '') {
      this.lastEventId = parsed.id
    }

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
      // A gap is a loss, not a reorder — polling is the only repair.
      this.schedulePoll()
    }
    this.deliver(outcome.deliveries, outcome.state)
    if (outcome.terminated) {
      this.stop()
    }
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
    try {
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
          this.stop()
          return
        }
        this.onPollFailed()
        return
      }

      this.pollFailures = 0
      const outcome = this.reconciler.handleSnapshot(response.body as Snapshot)
      if (outcome.stale) {
        this.diagnostics.onStaleSnapshot?.()
      }
      this.deliver(outcome.deliveries, outcome.state)
      if (outcome.hydrationCompleted && !this.stopped) {
        // Hydration can complete while 'connecting' (normal startup) or
        // 'polling' (first successful connect after starting degraded).
        this.setStatus(this.streamConnected ? 'live' : 'reconnecting')
      }
      if (outcome.terminated) {
        this.stop()
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
      this.setStatus(this.streamConnected ? 'live' : this.degraded ? 'polling' : 'reconnecting')
      if (outcome.terminated) this.stop()
    }
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
      for (const listener of this.eventListeners) listener(event)
      for (const feed of this.iteratorFeeds) feed.push(event)
    }
    if (state !== undefined) {
      for (const listener of this.stateListeners) listener(state.value as State)
    }
  }

  private setStatus(status: SubscriptionStatus): void {
    if (this.statusValue === status) return
    this.statusValue = status
    for (const listener of this.statusListeners) listener(status)
  }

  private waitMatching(
    matches: (event: FallbackEvent<Events>) => boolean,
    opts?: { timeoutMs?: number },
  ): Promise<FallbackEvent<Events>> {
    return new Promise((resolve, reject) => {
      if (this.stopped) {
        reject(new Error('Subscription is stopped'))
        return
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      const offStatus = this.onStatusChange((status) => {
        if (status === 'stopped') {
          cleanup()
          reject(new Error('Subscription stopped before the awaited event arrived'))
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
    nudge: () => impl.nudge(),
    stop: () => impl.stop(),
    waitFor: (event, opts) => impl.waitFor(event, opts),
    waitForTerminal: (opts) => impl.waitForTerminal(opts),
  }
}
