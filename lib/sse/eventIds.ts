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

export type CreateEventIdSequenceOptions = {
  /**
   * Epoch label prefixed to every id. Ids are only ordered *within* an epoch;
   * clients seeing an epoch change should resynchronize via a snapshot poll
   * rather than compare counters. Defaults to the creation timestamp in ms —
   * a process restart naturally starts a new (larger) epoch.
   */
  epoch?: string
  /** Starting counter value. Defaults to 0 (first id ends in ...000001). */
  start?: number
}

/**
 * Create a monotonic event-id sequence.
 *
 * Ids look like `"1754838000000-000000000042"`. Within one epoch they order
 * lexicographically (fixed-width zero-padded counter). Sequences are
 * in-memory and per-process — for cross-node monotonicity back the counter
 * with shared storage (e.g. Redis INCR) and stamp ids at the publisher.
 */
export function createEventIdSequence(options?: CreateEventIdSequenceOptions): EventIdSequence {
  const epoch = options?.epoch ?? String(Date.now())
  let counter = options?.start ?? 0
  let current: string | undefined

  return {
    next(): string {
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
