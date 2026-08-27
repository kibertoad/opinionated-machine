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
  /**
   * Whether the state layer is gap-suspended after this event. While
   * suspended `apply` is skipped, so `getState()` keeps returning the
   * pre-gap value even though events are still delivered — the caller must
   * poll for a repair snapshot and can surface the staleness meanwhile.
   */
  stateSuspended: boolean
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
  /** Whether the state layer is still gap-suspended after this snapshot. */
  stateSuspended: boolean
  /** This snapshot lifted a gap suspension and re-initialized state. */
  stateRepaired: boolean
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

  /**
   * Whether the state layer is suspended after a detected gap. `apply` stays
   * disabled until a snapshot repairs state, so `getState()` is known-stale
   * while this is true.
   */
  get isStateSuspended(): boolean {
    return this.stateSuspended
  }

  getState(): State | undefined {
    return this.stateValue
  }

  /** Start buffering live events until the next snapshot arrives. */
  beginHydration(): void {
    if (this.terminated) return
    this.hydrationBuffer = []
  }

  /**
   * Give up on subscribe-first hydration and resume direct delivery.
   *
   * The buffered events are FLUSHED, not discarded: hydration never completed,
   * so no snapshot subsumes them and dropping them would lose exactly the
   * events the buffer existed to protect. They pass through the version gate
   * in arrival order, so a later snapshot still wins on version.
   */
  abandonHydration(): SnapshotOutcome<Events> {
    const outcome: SnapshotOutcome<Events> = {
      deliveries: [],
      stale: false,
      advanced: false,
      hydrationCompleted: false,
      terminated: false,
      stateSuspended: this.stateSuspended,
      stateRepaired: false,
    }
    if (this.hydrationBuffer === null) return outcome
    this.finishHydration(null, outcome)
    return outcome
  }

  handleEvent(incoming: IncomingEvent): EventOutcome<Events> {
    const outcome: EventOutcome<Events> = {
      deliveries: [],
      duplicate: false,
      buffered: false,
      bufferOverflow: false,
      terminated: false,
      stateSuspended: this.stateSuspended,
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
    outcome.stateSuspended = this.stateSuspended
    return outcome
  }

  handleSnapshot(snapshot: Snapshot): SnapshotOutcome<Events> {
    const outcome: SnapshotOutcome<Events> = {
      deliveries: [],
      stale: false,
      advanced: false,
      hydrationCompleted: false,
      terminated: false,
      stateSuspended: this.stateSuspended,
      stateRepaired: false,
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
      // One exception: a gap-suspended state layer is repaired by ANY
      // snapshot, not only one whose version matches the watermark exactly.
      // Live events keep advancing the watermark after a gap, so the repair
      // snapshot this branch was polled for usually arrives strictly below it;
      // requiring equality left `apply` disabled forever and froze
      // `getState()` at its pre-gap value while events kept flowing.
      //
      // Re-initializing from a below-watermark snapshot can miss the effect of
      // events delivered between the snapshot and the watermark, but the gap
      // already lost events, and a stale-but-advancing state beats a state
      // that never updates again. The watermark is NOT rewound, so nothing is
      // re-delivered.
      if (this.stateSuspended && this.config.state) {
        this.stateValue = this.config.state.init(snapshot)
        this.stateInitialized = true
        this.stateSuspended = false
        outcome.state = { value: this.stateValue }
        outcome.stateRepaired = true
      }
      this.finishHydration(snapshotVersion, outcome)
      outcome.stateSuspended = this.stateSuspended
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
        // Nothing is delivered after the terminal event — `finishHydration`
        // and `handleEvent` apply the same rule.
        break
      }
    }

    // An empty synthetic list still advances the watermark: the poll proved
    // the state at snapshotVersion, so later stale arrivals must be droppable.
    if (versioned && snapshotVersion !== null) {
      this.highWatermark = snapshotVersion
    }
    outcome.advanced = true

    this.finishHydration(snapshotVersion, outcome)
    outcome.stateSuspended = this.stateSuspended
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
        stateSuspended: this.stateSuspended,
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
    // Default: the SSE id, when it is a shape this package can order —
    // a bare integer, or a `createEventIdSequence()` id.
    if (incoming.id === undefined || incoming.id === '') return undefined
    return parseDefaultVersion(incoming.id)
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
    const watermarkCounter = toCounter(watermark)
    const nextCounter = toCounter(next)
    if (watermarkCounter === undefined || nextCounter === undefined) return undefined
    // Counters restart with a new epoch, so a cross-epoch step is a
    // resynchronization point, not a measurable gap.
    if (watermarkCounter.epoch !== nextCounter.epoch) return undefined
    return nextCounter.counter > watermarkCounter.counter + 1n
      ? { from: watermark, to: next }
      : undefined
  }
}

const INTEGER_STRING_PATTERN = /^-?\d+$/

/**
 * The numeric value of a version, or `undefined` when comparing it as a
 * number would lose information.
 *
 * Integer strings beyond `Number.MAX_SAFE_INTEGER` are rejected here on
 * purpose: `Number('9007199254740992')` and `Number('9007199254740993')`
 * are the same double, so a numeric comparison would report the second event
 * as a duplicate of the first and drop it. Rejecting them hands the pair to
 * {@link compareSequence}, which compares the digits as `bigint`.
 */
function toNumeric(version: Version): number | undefined {
  if (typeof version === 'number') return version
  const numeric = Number(version)
  if (Number.isNaN(numeric)) return undefined
  if (INTEGER_STRING_PATTERN.test(version) && !Number.isSafeInteger(numeric)) return undefined
  return numeric
}

/**
 * Ids produced by the server-side `createEventIdSequence()`:
 * `"<numeric epoch>-<zero-padded counter>"`.
 *
 * The epoch is required to be numeric (it defaults to `Date.now()`) so that
 * ids in unrelated shapes are NOT mistaken for versions. A UUID, for example,
 * has several dashes and hex digits and cannot match — which matters, because
 * treating one as a version would order events at random and silently drop
 * them as duplicates. Deployments using a non-numeric epoch, or any other id
 * scheme, declare `version.ofEvent` explicitly.
 */
const SEQUENCE_ID_PATTERN = /^(\d+)-(\d+)$/

type SequenceParts = { epoch: bigint; counter: bigint }

function toCounter(version: Version): SequenceParts | undefined {
  if (typeof version === 'number') {
    return Number.isInteger(version) ? { epoch: 0n, counter: BigInt(version) } : undefined
  }
  const parsed = SEQUENCE_ID_PATTERN.exec(version)
  if (parsed) {
    return { epoch: BigInt(parsed[1] as string), counter: BigInt(parsed[2] as string) }
  }
  return /^\d+$/.test(version) ? { epoch: 0n, counter: BigInt(version) } : undefined
}

/**
 * The version a bare SSE `id:` carries under the default extractor: a bare
 * integer becomes a number, a `createEventIdSequence()` id stays a string
 * (ordered by {@link defaultCompareVersions}), anything else carries no
 * version at all.
 */
export function parseDefaultVersion(id: string): Version | undefined {
  if (/^\d+$/.test(id)) {
    const numeric = Number(id)
    return Number.isSafeInteger(numeric) ? numeric : id
  }
  return SEQUENCE_ID_PATTERN.test(id) ? id : undefined
}

/**
 * Numeric when both sides are numeric, epoch-then-counter when both are
 * `createEventIdSequence()` ids, lexicographic otherwise.
 *
 * Comparing sequence ids by their parsed parts rather than lexicographically
 * keeps ordering correct when the counter outgrows its zero padding, and
 * makes a new epoch (a process restart) sort above the old one, so the
 * restarted counter does not read as a flood of duplicates.
 */
export function defaultCompareVersions(a: Version, b: Version): number {
  const numeric = compareNumeric(a, b)
  if (numeric !== undefined) return numeric

  const sequence = compareSequence(a, b)
  if (sequence !== undefined) return sequence

  return compareLexicographic(String(a), String(b))
}

function compareNumeric(a: Version, b: Version): number | undefined {
  const aNumber = toNumeric(a)
  const bNumber = toNumeric(b)
  if (aNumber === undefined || bNumber === undefined) return undefined
  return aNumber === bNumber ? 0 : aNumber < bNumber ? -1 : 1
}

function compareSequence(a: Version, b: Version): number | undefined {
  const aParts = toCounter(a)
  const bParts = toCounter(b)
  if (!aParts || !bParts) return undefined
  if (aParts.epoch !== bParts.epoch) return aParts.epoch < bParts.epoch ? -1 : 1
  if (aParts.counter === bParts.counter) return 0
  return aParts.counter < bParts.counter ? -1 : 1
}

function compareLexicographic(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1
}
