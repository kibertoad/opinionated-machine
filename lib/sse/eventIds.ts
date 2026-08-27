/**
 * Monotonic event-id helpers for SSE streams.
 *
 * The polling-fallback pattern (and `Last-Event-ID` reconnection/replay in
 * general) needs event ids a client can ORDER, not just deduplicate: the
 * client keeps a high-watermark and drops anything at or below it. Random
 * UUIDs (the `broadcastToRoom` default) are unique but unordered; use a
 * sequence from {@link createEventIdSequence} instead and pass its ids
 * explicitly:
 *
 * ```ts
 * const seq = createEventIdSequence()
 * await broadcaster.broadcastToRoom(room, statusEvent, data, { id: seq.next() })
 * ```
 *
 * Keep one sequence per ordering scope (per room, per resource, per stream) —
 * ids from different scopes are not comparable. Stamp the same underlying
 * version into the sync (poll) response body so the client can order
 * snapshots against events.
 *
 * ## Choosing an id source
 *
 * Prefer a **domain version** (`job.version`, a revision column, an updated-at
 * revision counter) over a generated sequence whenever the resource has one.
 * A domain version is per-scope and writer-independent: any pod that writes the
 * resource reads the same version, and the same number is already what the
 * snapshot body has to carry for the client's version gate. Use
 * {@link createEventIdSequence} when the resource has no version of its own.
 *
 * ## Hazard: per-process sequences are single-writer only
 *
 * {@link createEventIdSequence} is in-memory and per-process. Its epoch
 * defaults to the process start time, and the client's default extractor
 * orders by epoch first. That is safe only when a single writer owns the
 * ordering scope.
 *
 * If two pods of the same service broadcast into the same room, each with its
 * own per-process sequence, their epochs differ. The events interleave, the
 * client's high-watermark lands on the newer epoch, and every subsequent event
 * from the older-epoch pod compares as stale and is **silently dropped**. The
 * failure only appears under horizontal scale, so it reaches production.
 *
 * For a multi-writer scope use one of:
 *
 * - a domain version (see above), or
 * - a shared counter, e.g. `createRedisEventIdSequence()` from
 *   `@opinionated-machine/sse-rooms-redis`, which backs the counter with
 *   Redis `INCR` and shares one epoch across pods, or
 * - a fixed `epoch` plus a `start` handed out from shared storage, so every
 *   writer contributes to a single ordered run.
 */

/**
 * A monotonic id generator: ids are lexicographically AND numerically
 * increasing within the sequence's epoch.
 */
export type EventIdSequence = {
  /** Produce the next id (`"<epoch>-<zero-padded counter>"`). */
  next(): string
  /** The most recently produced id, or `undefined` before the first next(). */
  readonly current: string | undefined
}

const COUNTER_PAD = 12

/**
 * Largest counter value that still fits in {@link COUNTER_PAD} digits. Beyond
 * this the id grows a digit and stops sorting after its predecessor, so
 * {@link createEventIdSequence} refuses to produce it.
 */
export const MAX_EVENT_ID_COUNTER = 999_999_999_999

export type CreateEventIdSequenceOptions = {
  /**
   * Epoch label prefixed to every id. Ids are only ordered *within* an epoch;
   * clients seeing an epoch change should resynchronize via a snapshot poll
   * rather than compare counters. Defaults to the creation timestamp in ms —
   * a process restart naturally starts a new (larger) epoch.
   *
   * Must be a non-empty string. Pass an explicit shared epoch when several
   * writers feed one ordering scope.
   */
  epoch?: string
  /**
   * Starting counter value. Defaults to 0 (first id ends in ...000001).
   *
   * Must be an integer in `[0, MAX_EVENT_ID_COUNTER - 1]`, so that at least one
   * id can still be produced without overflowing the fixed id width.
   */
  start?: number
}

/**
 * Create a monotonic event-id sequence.
 *
 * Ids look like `"1754838000000-000000000042"`. Within one epoch they order
 * lexicographically (fixed-width zero-padded counter).
 *
 * Sequences are in-memory and per-process, which makes them safe only for a
 * single-writer ordering scope. See the module docs for the multi-writer
 * hazard and the alternatives (domain versions, or a Redis-backed sequence).
 *
 * @throws TypeError if `epoch` is empty, or if `start` is not an integer in
 *   `[0, MAX_EVENT_ID_COUNTER - 1]`.
 */
export function createEventIdSequence(options?: CreateEventIdSequenceOptions): EventIdSequence {
  const epoch = options?.epoch ?? String(Date.now())
  if (epoch.length === 0) {
    throw new TypeError('createEventIdSequence: `epoch` must be a non-empty string')
  }

  const start = options?.start ?? 0
  if (!Number.isInteger(start) || start < 0 || start >= MAX_EVENT_ID_COUNTER) {
    throw new TypeError(
      `createEventIdSequence: \`start\` must be an integer in [0, ${MAX_EVENT_ID_COUNTER - 1}], got ${String(start)}`,
    )
  }

  let counter = start
  let current: string | undefined

  return {
    next(): string {
      if (counter >= MAX_EVENT_ID_COUNTER) {
        throw new RangeError(
          `createEventIdSequence: counter exhausted at ${MAX_EVENT_ID_COUNTER}; start a new epoch`,
        )
      }
      counter += 1
      current = `${epoch}-${String(counter).padStart(COUNTER_PAD, '0')}`
      return current
    },
    get current(): string | undefined {
      return current
    },
  }
}

const EVENT_ID_PATTERN = /^(.+)-(\d+)$/

/**
 * Compare two event ids produced by {@link createEventIdSequence}.
 *
 * Returns `-1` / `0` / `1` when both ids belong to the same epoch, and
 * `undefined` when they don't (or when either id doesn't match the expected
 * format). An `undefined` result means the ids are not ordered relative to
 * each other — clients should treat that as "resynchronize via a snapshot
 * poll" rather than guess.
 */
export function compareEventIds(a: string, b: string): -1 | 0 | 1 | undefined {
  const parsedA = EVENT_ID_PATTERN.exec(a)
  const parsedB = EVENT_ID_PATTERN.exec(b)
  if (!parsedA || !parsedB) return undefined
  if (parsedA[1] !== parsedB[1]) return undefined

  const counterA = BigInt(parsedA[2] as string)
  const counterB = BigInt(parsedB[2] as string)
  if (counterA < counterB) return -1
  if (counterA > counterB) return 1
  return 0
}

/**
 * The async counterpart of {@link EventIdSequence}, for sequences whose counter
 * lives in shared storage (e.g. `createRedisEventIdSequence()` from
 * `@opinionated-machine/sse-rooms-redis`).
 *
 * Ids have the same `"<epoch>-<zero-padded counter>"` shape, so
 * {@link compareEventIds} orders them too.
 */
export type AsyncEventIdSequence = {
  /** Produce the next id (`"<epoch>-<zero-padded counter>"`). */
  next(): Promise<string>
  /** The most recently produced id, or `undefined` before the first next(). */
  readonly current: string | undefined
}

/**
 * Format a counter value as an event id in the shape
 * {@link createEventIdSequence} produces, so ids from a shared counter compare
 * against ids from an in-process sequence with the same epoch.
 *
 * @throws RangeError if the counter does not fit the fixed id width.
 */
export function formatEventId(epoch: string, counter: number | bigint): string {
  const asBigInt = typeof counter === 'bigint' ? counter : BigInt(counter)
  if (asBigInt < 1n || asBigInt > BigInt(MAX_EVENT_ID_COUNTER)) {
    throw new RangeError(
      `formatEventId: counter must be in [1, ${MAX_EVENT_ID_COUNTER}], got ${String(counter)}`,
    )
  }
  return `${epoch}-${asBigInt.toString().padStart(COUNTER_PAD, '0')}`
}
