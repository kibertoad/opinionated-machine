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

/**
 * A break in the version sequence that only a snapshot can repair.
 *
 * `'sequence'` means the dense counter skipped ahead inside one epoch, so a
 * known number of events was lost. `'epoch-change'` means the id epoch itself
 * changed (a writer restarted, or the ordering scope was reset): counters on
 * either side are not comparable, so the number of missed events is unknowable
 * and delta state has to be rebuilt from a snapshot rather than carried across.
 */
export type VersionGap = {
  from: Version
  to: Version
  reason: 'sequence' | 'epoch-change'
}

/**
 * A version extractor returned a value that cannot be ordered — `undefined`
 * from `version.ofSnapshot` (a snapshot body missing its version field is the
 * usual cause), `NaN`, `Infinity`, an empty string, or a non-scalar.
 *
 * The item is still delivered, just without advancing the watermark, so the
 * subscription degrades to at-least-once rather than wedging. This exists so
 * that degradation is visible instead of silent.
 */
export type InvalidVersionInfo = {
  source: 'snapshot' | 'event'
  value: unknown
}

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
  /** A gap or an epoch change was detected — caller should poll now. */
  gap?: VersionGap
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
  /**
   * A gap was detected while flushing the hydration buffer — caller should
   * poll now. Buffered events pass through the same version gate as live
   * ones, so the hole they expose needs the same repair poll; without this
   * the gap would be found and then silently dropped with the flush outcome.
   */
  gap?: VersionGap
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
  /**
   * Events delivered while the state layer is gap-suspended, in arrival
   * order, so the repair snapshot can re-apply the ones it does not cover.
   */
  private stateReplayBuffer: Array<{
    delivered: FallbackEvent<Events>
    version: Version | undefined
  }> = []
  /**
   * The replay buffer overflowed and was dropped. A below-watermark snapshot
   * can no longer repair state without losing the events it does not cover,
   * so the suspension holds until a snapshot reaches the watermark.
   */
  private stateReplayTruncated = false
  private terminated = false
  private readonly onInvalidVersion: ((info: InvalidVersionInfo) => void) | undefined

  constructor(
    config: FallbackBindingConfig<Snapshot, Events, State>,
    options: {
      hydrationBufferLimit: number
      /**
       * Reported when a version extractor hands back something that cannot be
       * ordered. Purely observational — the reconciler degrades on its own.
       */
      onInvalidVersion?: (info: InvalidVersionInfo) => void
    },
  ) {
    this.config = config
    this.onInvalidVersion = options.onInvalidVersion
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
    // A version this reconciler cannot order (a body missing the field, NaN,
    // an empty string) is treated as no version at all rather than stored:
    // an unorderable watermark compares as "not less than" against every
    // later item, which would drop the whole stream as stale duplicates.
    const snapshotVersion = versioned
      ? (this.normalizeVersion(
          (this.config.version as { ofSnapshot: (s: Snapshot) => Version }).ofSnapshot(snapshot),
          'snapshot',
        ) ?? null)
      : null

    // An epoch change re-scopes ordering, so counters on either side are not
    // comparable and "below the watermark" means nothing: a snapshot from the
    // new epoch is the resync, not a stale arrival. Without this a writer
    // migrated to a lower epoch (the documented `createEventIdSequence` ->
    // `createRedisEventIdSequence` move) would have every snapshot dropped.
    const epochChanged =
      snapshotVersion !== null &&
      this.highWatermark !== null &&
      this.isEpochChange(this.highWatermark, snapshotVersion)

    const watermarkComparison =
      !epochChanged && snapshotVersion !== null && this.highWatermark !== null
        ? this.compare(snapshotVersion, this.highWatermark)
        : undefined

    if (snapshotVersion !== null && watermarkComparison !== undefined && watermarkComparison <= 0) {
      return this.handleStaleSnapshot(snapshot, snapshotVersion, watermarkComparison, outcome)
    }

    // Deliver the snapshot: state layer first (replacement semantics), then
    // synthesized events. Synthetic events are NOT applied to state — the
    // snapshot already subsumes them.
    if (this.config.state) {
      this.stateValue = this.config.state.init(snapshot)
      this.stateInitialized = true
      // This snapshot is at or above the watermark, so it covers every event
      // delivered during a suspension: there is nothing left to replay.
      this.stateSuspended = false
      this.stateReplayBuffer = []
      this.stateReplayTruncated = false
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

  /**
   * The stale-poll race: everything this snapshot describes has already been
   * delivered (or superseded) through the stream.
   *
   * One exception: a gap-suspended state layer is repaired by ANY snapshot,
   * not only one whose version matches the watermark exactly. Live events keep
   * advancing the watermark after a gap, so the repair snapshot this branch
   * was polled for usually arrives strictly below it; requiring equality left
   * `apply` disabled forever and froze `getState()` at its pre-gap value while
   * events kept flowing. The events the snapshot does not cover are replayed
   * onto it, so nothing delivered during the suspension is dropped from state.
   * The watermark is NOT rewound, so nothing is re-delivered.
   *
   * With a dropped replay buffer that is impossible, so the suspension holds
   * until a snapshot reaches the watermark, which covers everything delivered
   * during it and needs no replay.
   */
  private handleStaleSnapshot(
    snapshot: Snapshot,
    snapshotVersion: Version,
    watermarkComparison: number,
    outcome: SnapshotOutcome<Events>,
  ): SnapshotOutcome<Events> {
    outcome.stale = true
    const canRepair = !this.stateReplayTruncated || watermarkComparison === 0
    if (this.stateSuspended && this.config.state && canRepair) {
      this.repairState(snapshot, snapshotVersion, outcome)
    }
    this.finishHydration(snapshotVersion, outcome)
    outcome.stateSuspended = this.stateSuspended
    return outcome
  }

  /**
   * Re-initialize a gap-suspended state layer from a snapshot below the
   * watermark, then re-apply the buffered events the snapshot does not cover.
   *
   * The repair snapshot is usually older than the watermark, because live
   * events keep arriving while the repair poll is in flight. Without the
   * replay those events would be missing from state permanently: delivered to
   * listeners, skipped by `apply` while suspended, then overwritten by an
   * `init` that predates them. The next event would apply to a state that
   * never saw them.
   *
   * The cut is by arrival order, anchored on the last buffered event the
   * snapshot demonstrably covers. Events after it are replayed even when they
   * carry no orderable version, because arrival order is the only ordering
   * they have.
   */
  private repairState(
    snapshot: Snapshot,
    snapshotVersion: Version,
    outcome: SnapshotOutcome<Events>,
  ): void {
    const state = this.config.state
    if (!state) return

    this.stateValue = state.init(snapshot)
    this.stateInitialized = true
    this.stateSuspended = false

    const buffered = this.stateReplayBuffer
    this.stateReplayBuffer = []
    this.stateReplayTruncated = false

    let covered = -1
    for (const [index, entry] of buffered.entries()) {
      if (entry.version !== undefined && this.compare(entry.version, snapshotVersion) <= 0) {
        covered = index
      }
    }
    for (const entry of buffered.slice(covered + 1)) {
      this.stateValue = state.apply(this.stateValue as State, entry.delivered)
    }

    outcome.state = { value: this.stateValue }
    outcome.stateRepaired = true
  }

  /**
   * Keep a delivered event for the repair snapshot to replay. Overflow drops
   * the whole buffer rather than half of it: replaying a partial buffer would
   * apply deltas across a hole, which is exactly what the suspension exists
   * to prevent.
   */
  private recordSuspendedEvent(
    delivered: FallbackEvent<Events>,
    version: Version | undefined,
  ): void {
    if (this.stateReplayTruncated) return
    if (this.stateReplayBuffer.length >= this.hydrationBufferLimit) {
      this.stateReplayBuffer = []
      this.stateReplayTruncated = true
      return
    }
    this.stateReplayBuffer.push({ delivered, version })
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
      // The first hole is enough: one repair poll covers every later one, and
      // reporting the earliest keeps `from` at the last version actually
      // delivered before the loss.
      if (eventOutcome.gap && !outcome.gap) outcome.gap = eventOutcome.gap
      if (eventOutcome.terminated) outcome.terminated = true
    }
    outcome.stateSuspended = this.stateSuspended
    // snapshotVersion is already the watermark, so gateAndDeliver dropped
    // anything the snapshot subsumed. (Parameter kept for readability.)
    void snapshotVersion
  }

  /**
   * Record a detected gap on the outcome and suspend the state layer, so the
   * caller polls for a repair snapshot instead of applying deltas across a
   * hole.
   */
  private registerGap(gap: VersionGap, outcome: EventOutcome<Events>): void {
    outcome.gap = gap
    if (this.config.state && (this.config.state.reinitOnGap ?? true)) {
      // Deltas must not be applied across a gap; the repair snapshot
      // re-initializes state.
      this.stateSuspended = true
    }
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
        const gap = this.detectGap(this.highWatermark, version)
        // An epoch change is resolved BEFORE the duplicate gate, because the
        // two epochs are not comparable: a lower epoch is not an older event,
        // it is a different ordering scope. Ranking it as a duplicate is how
        // a writer that moved to a lower epoch (the documented
        // `createEventIdSequence` -> `createRedisEventIdSequence` migration,
        // whose DEFAULT_EPOCH is '0') wedged the subscription for good —
        // every event sorted below a watermark it could never reach.
        // Adopting the new epoch and reporting the gap turns that into what
        // the docs promise: a resync poll. Two writers with different epochs
        // broadcasting into one room (explicitly unsupported) now alternate
        // gaps instead of silently dropping one writer's events; the repair
        // polls are rate-limited by the deadman backoff and the poll gate.
        if (gap?.reason === 'epoch-change' && this.ordersEpochs) {
          this.registerGap(gap, outcome)
        } else {
          const comparison = this.compare(version, this.highWatermark)
          if (comparison <= 0) {
            outcome.duplicate = true
            return
          }
          if (gap) this.registerGap(gap, outcome)
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
    } else if (this.config.state && this.stateSuspended) {
      this.recordSuspendedEvent(delivered, version)
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
      const extracted = versionConfig.ofEvent({
        event: incoming.event,
        data: incoming.data,
        ...(incoming.id !== undefined ? { id: incoming.id } : {}),
        origin: 'sse',
      } as FallbackEvent<Events>)
      // `undefined` is a documented answer here ("this event carries no
      // version"), so it is not reported; anything else unorderable is.
      return extracted === undefined ? undefined : this.normalizeVersion(extracted, 'event')
    }
    // Default: the SSE id, when it is a shape this package can order —
    // a bare integer, or a `createEventIdSequence()` id.
    if (incoming.id === undefined || incoming.id === '') return undefined
    return parseDefaultVersion(incoming.id)
  }

  /**
   * A version the gate can actually order, or `undefined`.
   *
   * Nothing in the type system stops an extractor from handing back
   * `undefined` (a snapshot body whose version field is absent), `NaN`, an
   * empty string or an object, and storing one as the watermark is the worst
   * outcome the gate has: `defaultCompareVersions` falls through to a
   * lexicographic comparison against `'undefined'`/`'NaN'`, every later item
   * ranks at or below it, and the subscription drops everything as a
   * duplicate — silently, forever. Dropping the version instead costs
   * deduplication (at-least-once delivery) and keeps the stream flowing.
   */
  private normalizeVersion(value: unknown, source: 'snapshot' | 'event'): Version | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value !== '') return value
    this.onInvalidVersion?.({ source, value })
    return undefined
  }

  /**
   * Whether the epoch bypass below applies. A binding that declares
   * `version.compare` owns ordering end to end, including across epochs, so
   * its verdict is never overridden here — the bypass exists to correct the
   * DEFAULT comparator, which ranks by epoch and therefore reads a lowered
   * epoch as an older version.
   */
  private get ordersEpochs(): boolean {
    const versionConfig = this.config.version
    return versionConfig !== 'none' && versionConfig.compare === undefined
  }

  /**
   * Whether two versions belong to different ordering scopes under the
   * default comparator — see {@link ordersEpochs}.
   */
  private isEpochChange(a: Version, b: Version): boolean {
    return this.ordersEpochs && isEpochChange(a, b)
  }

  private compare(a: Version, b: Version): number {
    const versionConfig = this.config.version
    if (versionConfig !== 'none' && versionConfig.compare) {
      return versionConfig.compare(a, b)
    }
    return defaultCompareVersions(a, b)
  }

  private detectGap(watermark: Version, next: Version): VersionGap | undefined {
    const versionConfig = this.config.version
    if (versionConfig === 'none') return undefined
    const watermarkCounter = toCounter(watermark)
    const nextCounter = toCounter(next)
    if (watermarkCounter === undefined || nextCounter === undefined) return undefined
    // Counters restart with a new epoch, so a cross-epoch step measures
    // nothing — which makes it MORE of a resynchronization point, not less.
    // Reporting it repairs delta state from a snapshot; staying silent would
    // apply deltas across the restart and let a busy stream keep the deadman
    // moving, so the repair never happens.
    if (watermarkCounter.epoch !== nextCounter.epoch) {
      return { from: watermark, to: next, reason: 'epoch-change' }
    }
    // A skipped counter is only measurable when the versions are dense.
    if (!versionConfig.dense) return undefined
    return nextCounter.counter > watermarkCounter.counter + 1n
      ? { from: watermark, to: next, reason: 'sequence' }
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
 * The epoch is required to be numeric so that ids in unrelated shapes are NOT
 * mistaken for versions. A UUID, for example, has several dashes and hex digits
 * and cannot match — which matters, because treating one as a version would
 * order events at random and silently drop them as duplicates. The server-side
 * generators (`createEventIdSequence`, `formatEventId`,
 * `createRedisEventIdSequence`) refuse a non-numeric epoch for exactly this
 * reason, so every id they produce is one this extractor can order. Any other
 * id scheme declares `version.ofEvent` explicitly.
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
 * Whether two versions belong to different ordering scopes (a writer restart,
 * or a move to a differently-seeded sequence). Counters on either side of an
 * epoch change measure nothing against each other, so neither "newer" nor
 * "older" is meaningful — only "resync".
 */
function isEpochChange(a: Version, b: Version): boolean {
  const left = toCounter(a)
  const right = toCounter(b)
  if (left === undefined || right === undefined) return false
  return left.epoch !== right.epoch
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
