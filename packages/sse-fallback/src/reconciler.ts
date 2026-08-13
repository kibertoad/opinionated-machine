import type {
  EventPayloadMap,
  FallbackBindingConfig,
  FallbackEvent,
  Version,
} from './bindingTypes.ts'

/**
 * The reconciler is the pure correctness core of the fallback pattern: a
 * version-gated event pipeline with a high-watermark, hydration buffering,
 * and gap detection. It owns NO timers and NO transport — the subscription
 * wires those around it — which keeps every race testable synchronously.
 *
 * The single delivery rule: an item (event or snapshot) with version `v` is
 * delivered iff `v` is greater than the high-watermark; delivery advances
 * the watermark. That one rule simultaneously handles duplicate delivery
 * (SSE event + poll snapshot of the same update), the stale-poll race (a
 * slow poll response arriving AFTER a newer pushed event is dropped at
 * arrival time), and replay overlap after reconnection.
 */

export type IncomingEvent = {
  event: string
  data: unknown
  id?: string
}

export type EventOutcome<Events extends EventPayloadMap> = {
  deliveries: Array<FallbackEvent<Events>>
  /** Event was at/below the watermark and dropped. */
  duplicate: boolean
  /** Event was buffered (hydration in progress). */
  buffered: boolean
  /** Hydration buffer overflowed — caller must refetch the snapshot. */
  bufferOverflow: boolean
  /** A sequence gap was detected (dense versions) — caller should poll now. */
  gap?: { from: Version; to: Version }
  /** A terminal event was delivered — the subscription is complete. */
  terminated: boolean
  /** New state value when the state layer applied the event. */
  state?: { value: unknown }
}

export type SnapshotOutcome<Events extends EventPayloadMap> = {
  deliveries: Array<FallbackEvent<Events>>
  /** Snapshot was at/below the watermark and dropped entirely. */
  stale: boolean
  /** The watermark (or versionless equivalent) advanced — the poll carried news. */
  advanced: boolean
  /** Hydration completed with this snapshot (buffered events were flushed). */
  hydrationCompleted: boolean
  terminated: boolean
  state?: { value: unknown }
}

export class Reconciler<Snapshot, Events extends EventPayloadMap, State> {
  private readonly config: FallbackBindingConfig<Snapshot, Events, State>
  private readonly snapshotToEvents: (
    snapshot: Snapshot,
  ) => ReadonlyArray<{ event: string; data: unknown }>
  private readonly terminalSet: ReadonlySet<string>
  private highWatermark: Version | null = null
  private hydrationBuffer: IncomingEvent[] | null = null
  private readonly hydrationBufferLimit: number
  private stateValue: State | undefined
  private stateInitialized = false
  private stateSuspended = false
  private terminated = false

  constructor(
    config: FallbackBindingConfig<Snapshot, Events, State>,
    options: { hydrationBufferLimit: number },
  ) {
    this.config = config
    const shorthandEvent = config.snapshotEvent
    this.snapshotToEvents =
      config.snapshotToEvents ??
      (shorthandEvent !== undefined
        ? (snapshot) => [{ event: shorthandEvent, data: snapshot }]
        : () => [])
    this.terminalSet = new Set(config.terminalEvents ?? [])
    this.hydrationBufferLimit = options.hydrationBufferLimit
  }

  get isTerminated(): boolean {
    return this.terminated
  }

  get isHydrating(): boolean {
    return this.hydrationBuffer !== null
  }

  getState(): State | undefined {
    return this.stateValue
  }

  /** Start buffering live events until the next snapshot arrives. */
  beginHydration(): void {
    if (this.terminated) return
    this.hydrationBuffer = []
  }

  /** Abandon hydration buffering (e.g. hydration poll failed terminally). */
  abandonHydration(): void {
    this.hydrationBuffer = null
  }

  handleEvent(incoming: IncomingEvent): EventOutcome<Events> {
    const outcome: EventOutcome<Events> = {
      deliveries: [],
      duplicate: false,
      buffered: false,
      bufferOverflow: false,
      terminated: false,
    }
    if (this.terminated) return outcome

    if (this.hydrationBuffer !== null) {
      if (this.hydrationBuffer.length >= this.hydrationBufferLimit) {
        // Drop the buffer; the caller refetches the snapshot, which subsumes
        // everything dropped (or is older than still-flowing live events,
        // which the version gate handles either way).
        this.hydrationBuffer = []
        outcome.bufferOverflow = true
        return outcome
      }
      this.hydrationBuffer.push(incoming)
      outcome.buffered = true
      return outcome
    }

    this.gateAndDeliver(incoming, 'sse', outcome)
    return outcome
  }

  handleSnapshot(snapshot: Snapshot): SnapshotOutcome<Events> {
    const outcome: SnapshotOutcome<Events> = {
      deliveries: [],
      stale: false,
      advanced: false,
      hydrationCompleted: false,
      terminated: false,
    }
    if (this.terminated) return outcome

    const versioned = this.config.version !== 'none'
    const snapshotVersion = versioned
      ? (this.config.version as { ofSnapshot: (s: Snapshot) => Version }).ofSnapshot(snapshot)
      : null

    if (
      versioned &&
      snapshotVersion !== null &&
      this.highWatermark !== null &&
      this.compare(snapshotVersion, this.highWatermark) <= 0
    ) {
      // The stale-poll race: everything this snapshot describes has already
      // been delivered (or superseded) through the stream.
      outcome.stale = true
      // One exception: while the state layer is gap-suspended, a snapshot AT
      // the watermark is exactly the repair we polled for — the gapped event
      // advanced the watermark to its own version, so the repair snapshot
      // legitimately arrives with an equal version. Re-initialize state and
      // lift the suspension (events stay dropped — nothing new to deliver).
      if (
        this.stateSuspended &&
        this.config.state &&
        this.compare(snapshotVersion, this.highWatermark) === 0
      ) {
        this.stateValue = this.config.state.init(snapshot)
        this.stateInitialized = true
        this.stateSuspended = false
        outcome.state = { value: this.stateValue }
      }
      this.finishHydration(snapshotVersion, outcome)
      return outcome
    }

    // Deliver the snapshot: state layer first (replacement semantics), then
    // synthesized events. Synthetic events are NOT applied to state — the
    // snapshot already subsumes them.
    if (this.config.state) {
      this.stateValue = this.config.state.init(snapshot)
      this.stateInitialized = true
      this.stateSuspended = false
      outcome.state = { value: this.stateValue }
    }

    const synthetic = this.snapshotToEvents(snapshot)
    for (const event of synthetic) {
      const delivered = {
        ...event,
        origin: 'poll',
      } as FallbackEvent<Events>
      outcome.deliveries.push(delivered)
      if (this.terminalSet.has(event.event)) {
        this.terminated = true
        outcome.terminated = true
      }
    }

    // An empty synthetic list still advances the watermark: the poll proved
    // the state at snapshotVersion, so later stale arrivals must be droppable.
    if (versioned && snapshotVersion !== null) {
      this.highWatermark = snapshotVersion
    }
    outcome.advanced = true

    this.finishHydration(snapshotVersion, outcome)
    return outcome
  }

  private finishHydration(snapshotVersion: Version | null, outcome: SnapshotOutcome<Events>): void {
    if (this.hydrationBuffer === null) return
    const buffered = this.hydrationBuffer
    this.hydrationBuffer = null
    outcome.hydrationCompleted = true

    // Flush buffered live events newer than the snapshot, in arrival order.
    // Everything at or below the snapshot version is subsumed by it.
    for (const incoming of buffered) {
      if (this.terminated) break
      const eventOutcome: EventOutcome<Events> = {
        deliveries: [],
        duplicate: false,
        buffered: false,
        bufferOverflow: false,
        terminated: false,
      }
      this.gateAndDeliver(incoming, 'sse', eventOutcome)
      outcome.deliveries.push(...eventOutcome.deliveries)
      if (eventOutcome.state) outcome.state = eventOutcome.state
      if (eventOutcome.terminated) outcome.terminated = true
    }
    // snapshotVersion is already the watermark, so gateAndDeliver dropped
    // anything the snapshot subsumed. (Parameter kept for readability.)
    void snapshotVersion
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the version gate is the correctness core — splitting it would scatter the invariants it guards
  private gateAndDeliver(
    incoming: IncomingEvent,
    origin: 'sse' | 'poll',
    outcome: EventOutcome<Events>,
  ): void {
    const versioned = this.config.version !== 'none'
    let version: Version | undefined
    if (versioned) {
      version = this.extractEventVersion(incoming)
      if (version !== undefined && this.highWatermark !== null) {
        const comparison = this.compare(version, this.highWatermark)
        if (comparison <= 0) {
          outcome.duplicate = true
          return
        }
        const gap = this.detectGap(this.highWatermark, version)
        if (gap) {
          outcome.gap = gap
          if (this.config.state && (this.config.state.reinitOnGap ?? true)) {
            // Deltas must not be applied across a gap; the repair snapshot
            // re-initializes state.
            this.stateSuspended = true
          }
        }
      }
    }

    const delivered = {
      event: incoming.event,
      data: incoming.data,
      ...(incoming.id !== undefined ? { id: incoming.id } : {}),
      origin,
    } as FallbackEvent<Events>
    outcome.deliveries.push(delivered)

    if (this.config.state && this.stateInitialized && !this.stateSuspended) {
      this.stateValue = this.config.state.apply(this.stateValue as State, delivered)
      outcome.state = { value: this.stateValue }
    }

    if (versioned && version !== undefined) {
      this.highWatermark = version
    }

    if (this.terminalSet.has(incoming.event)) {
      this.terminated = true
      outcome.terminated = true
    }
  }

  private extractEventVersion(incoming: IncomingEvent): Version | undefined {
    const versionConfig = this.config.version
    if (versionConfig === 'none') return undefined
    if (versionConfig.ofEvent) {
      return versionConfig.ofEvent({
        event: incoming.event,
        data: incoming.data,
        ...(incoming.id !== undefined ? { id: incoming.id } : {}),
        origin: 'sse',
      } as FallbackEvent<Events>)
    }
    // Default: numeric SSE id (pair with server-side monotonic id stamping).
    if (incoming.id === undefined || incoming.id === '') return undefined
    const numeric = Number(incoming.id)
    return Number.isNaN(numeric) ? undefined : numeric
  }

  private compare(a: Version, b: Version): number {
    const versionConfig = this.config.version
    if (versionConfig !== 'none' && versionConfig.compare) {
      return versionConfig.compare(a, b)
    }
    return defaultCompareVersions(a, b)
  }

  private detectGap(watermark: Version, next: Version): { from: Version; to: Version } | undefined {
    const versionConfig = this.config.version
    if (versionConfig === 'none' || !versionConfig.dense) return undefined
    const watermarkNumber = toNumeric(watermark)
    const nextNumber = toNumeric(next)
    if (watermarkNumber === undefined || nextNumber === undefined) return undefined
    return nextNumber > watermarkNumber + 1 ? { from: watermark, to: next } : undefined
  }
}

function toNumeric(version: Version): number | undefined {
  if (typeof version === 'number') return version
  const numeric = Number(version)
  return Number.isNaN(numeric) ? undefined : numeric
}

/** Numeric when both sides are numeric; lexicographic otherwise. */
export function defaultCompareVersions(a: Version, b: Version): number {
  const aNumber = toNumeric(a)
  const bNumber = toNumeric(b)
  if (aNumber !== undefined && bNumber !== undefined) {
    return aNumber === bNumber ? 0 : aNumber < bNumber ? -1 : 1
  }
  const aString = String(a)
  const bString = String(b)
  return aString === bString ? 0 : aString < bString ? -1 : 1
}
