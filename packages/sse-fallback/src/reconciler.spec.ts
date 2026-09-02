import { describe, expect, it } from 'vitest'
import type { FallbackBindingConfig } from './bindingTypes.ts'
import { defaultCompareVersions, Reconciler } from './reconciler.ts'

type JobSnapshot = { status: 'pending' | 'completed'; result?: string; version: number }
type JobEvents = {
  progress: { percent: number }
  done: { result: string }
}

const jobConfig: FallbackBindingConfig<JobSnapshot, JobEvents> = {
  snapshotToEvents: (s) =>
    s.status === 'completed' ? [{ event: 'done', data: { result: s.result as string } }] : [],
  version: { ofSnapshot: (s) => s.version },
  terminalEvents: ['done'],
}

function jobReconciler(overrides?: Partial<FallbackBindingConfig<JobSnapshot, JobEvents>>) {
  return new Reconciler({ ...jobConfig, ...overrides }, { hydrationBufferLimit: 3 })
}

describe('Reconciler — version gate', () => {
  it('delivers events with increasing versions and advances the watermark', () => {
    const reconciler = jobReconciler()
    const first = reconciler.handleEvent({ event: 'progress', data: { percent: 10 }, id: '1' })
    const second = reconciler.handleEvent({ event: 'progress', data: { percent: 20 }, id: '2' })

    expect(first.deliveries).toHaveLength(1)
    expect(second.deliveries).toHaveLength(1)
    expect(first.duplicate).toBe(false)
    expect(second.duplicate).toBe(false)
  })

  it('drops events at or below the watermark (duplicate delivery)', () => {
    const reconciler = jobReconciler()
    reconciler.handleEvent({ event: 'progress', data: { percent: 20 }, id: '2' })

    const replayOfOlder = reconciler.handleEvent({
      event: 'progress',
      data: { percent: 10 },
      id: '1',
    })
    const replayOfSame = reconciler.handleEvent({
      event: 'progress',
      data: { percent: 20 },
      id: '2',
    })

    expect(replayOfOlder.duplicate).toBe(true)
    expect(replayOfOlder.deliveries).toHaveLength(0)
    expect(replayOfSame.duplicate).toBe(true)
  })

  it('drops a stale snapshot arriving after a newer event (the stale-poll race)', () => {
    const reconciler = jobReconciler()
    // SSE delivered version 10 while a poll was in flight...
    reconciler.handleEvent({ event: 'progress', data: { percent: 99 }, id: '10' })
    // ...and the slow poll response describes version 9.
    const outcome = reconciler.handleSnapshot({ status: 'completed', result: 'STALE', version: 9 })

    expect(outcome.stale).toBe(true)
    expect(outcome.deliveries).toHaveLength(0)
    expect(outcome.terminated).toBe(false)
  })

  it('advances the watermark on a snapshot with no synthesized events', () => {
    const reconciler = jobReconciler()
    const pending = reconciler.handleSnapshot({ status: 'pending', version: 5 })
    expect(pending.deliveries).toHaveLength(0)
    expect(pending.advanced).toBe(true)

    // The poll proved state at v5 — older events must now be droppable.
    const older = reconciler.handleEvent({ event: 'progress', data: { percent: 10 }, id: '4' })
    expect(older.duplicate).toBe(true)
  })

  it('delivers events without extractable versions but does not advance the watermark', () => {
    const reconciler = jobReconciler()
    reconciler.handleEvent({ event: 'progress', data: { percent: 10 }, id: '3' })

    const unversioned = reconciler.handleEvent({ event: 'progress', data: { percent: 11 } })
    expect(unversioned.deliveries).toHaveLength(1)

    // Watermark unchanged: id 3 is still the high-water mark.
    const older = reconciler.handleEvent({ event: 'progress', data: { percent: 9 }, id: '2' })
    expect(older.duplicate).toBe(true)
  })
})

describe('Reconciler — terminal events', () => {
  it('terminates on a pushed terminal event and drops everything after', () => {
    const reconciler = jobReconciler()
    const done = reconciler.handleEvent({ event: 'done', data: { result: 'ok' }, id: '5' })
    expect(done.terminated).toBe(true)

    const late = reconciler.handleEvent({ event: 'progress', data: { percent: 100 }, id: '6' })
    expect(late.deliveries).toHaveLength(0)
    const lateSnapshot = reconciler.handleSnapshot({
      status: 'completed',
      result: 'ok',
      version: 7,
    })
    expect(lateSnapshot.deliveries).toHaveLength(0)
  })

  it('terminates on a poll-synthesized terminal event (transparent completion)', () => {
    const reconciler = jobReconciler()
    const outcome = reconciler.handleSnapshot({ status: 'completed', result: 'ok', version: 3 })
    expect(outcome.deliveries).toEqual([{ event: 'done', data: { result: 'ok' }, origin: 'poll' }])
    expect(outcome.terminated).toBe(true)
  })
})

describe('Reconciler — hydration (subscribe-first, buffer, fetch)', () => {
  it('buffers events during hydration and flushes only those newer than the snapshot', () => {
    const reconciler = jobReconciler()
    reconciler.beginHydration()

    // Live events arrive while the snapshot fetch is in flight.
    expect(
      reconciler.handleEvent({ event: 'progress', data: { percent: 40 }, id: '4' }).buffered,
    ).toBe(true)
    expect(
      reconciler.handleEvent({ event: 'progress', data: { percent: 60 }, id: '6' }).buffered,
    ).toBe(true)

    // Snapshot at version 5: subsumes v4, is older than v6.
    const outcome = reconciler.handleSnapshot({ status: 'pending', version: 5 })
    expect(outcome.hydrationCompleted).toBe(true)
    expect(outcome.deliveries).toEqual([
      { event: 'progress', data: { percent: 60 }, id: '6', origin: 'sse' },
    ])
  })

  it('reports overflow so the caller can drop-and-refetch', () => {
    const reconciler = jobReconciler() // hydrationBufferLimit: 3
    reconciler.beginHydration()
    for (let i = 1; i <= 3; i++) {
      reconciler.handleEvent({ event: 'progress', data: { percent: i }, id: String(i) })
    }
    const overflowing = reconciler.handleEvent({ event: 'progress', data: { percent: 4 }, id: '4' })
    expect(overflowing.bufferOverflow).toBe(true)
    expect(reconciler.isHydrating).toBe(true)

    // A later snapshot still completes hydration.
    const outcome = reconciler.handleSnapshot({ status: 'pending', version: 10 })
    expect(outcome.hydrationCompleted).toBe(true)
  })
})

describe('Reconciler — gap detection (dense versions)', () => {
  it('detects a sequence gap, still delivers the newer event, never regresses', () => {
    const reconciler = jobReconciler({
      version: { ofSnapshot: (s) => s.version, dense: true },
    })
    reconciler.handleEvent({ event: 'progress', data: { percent: 10 }, id: '1' })
    const gapped = reconciler.handleEvent({ event: 'progress', data: { percent: 30 }, id: '3' })

    expect(gapped.gap).toEqual({ from: 1, to: 3, reason: 'sequence' })
    expect(gapped.deliveries).toHaveLength(1)

    // Watermark is 3 — the missing 2 can no longer sneak in.
    const missing = reconciler.handleEvent({ event: 'progress', data: { percent: 20 }, id: '2' })
    expect(missing.duplicate).toBe(true)
  })

  it('does not flag consecutive versions as gaps', () => {
    const reconciler = jobReconciler({
      version: { ofSnapshot: (s) => s.version, dense: true },
    })
    reconciler.handleEvent({ event: 'progress', data: { percent: 10 }, id: '1' })
    const next = reconciler.handleEvent({ event: 'progress', data: { percent: 20 }, id: '2' })
    expect(next.gap).toBeUndefined()
  })
})

describe('Reconciler — state layer', () => {
  type CounterState = { revision: number; items: string[] }
  type CounterSnapshot = { revision: number; items: string[] }
  type CounterEvents = { itemAdded: { revision: number; item: string } }

  const stateConfig: FallbackBindingConfig<CounterSnapshot, CounterEvents, CounterState> = {
    snapshotEvent: undefined,
    snapshotToEvents: () => [],
    version: {
      ofSnapshot: (s) => s.revision,
      ofEvent: (e) => e.data.revision,
      dense: true,
    },
    state: {
      init: (s) => ({ revision: s.revision, items: [...s.items] }),
      apply: (state, e) => ({
        revision: e.data.revision,
        items: [...state.items, e.data.item],
      }),
    },
  }

  function stateReconciler() {
    return new Reconciler(stateConfig, { hydrationBufferLimit: 10 })
  }

  it('initializes state from a snapshot and applies live deltas', () => {
    const reconciler = stateReconciler()
    reconciler.handleSnapshot({ revision: 1, items: ['a'] })
    reconciler.handleEvent({ event: 'itemAdded', data: { revision: 2, item: 'b' } })

    expect(reconciler.getState()).toEqual({ revision: 2, items: ['a', 'b'] })
  })

  it('replaces (not merges) state on a newer snapshot', () => {
    const reconciler = stateReconciler()
    reconciler.handleSnapshot({ revision: 1, items: ['a'] })
    reconciler.handleEvent({ event: 'itemAdded', data: { revision: 2, item: 'b' } })
    reconciler.handleSnapshot({ revision: 5, items: ['fresh'] })

    expect(reconciler.getState()).toEqual({ revision: 5, items: ['fresh'] })
  })

  it('suspends delta application across a gap until the repair snapshot', () => {
    const reconciler = stateReconciler()
    reconciler.handleSnapshot({ revision: 1, items: ['a'] })

    // revision 3 arrives without revision 2 — applying it would corrupt state.
    const gapped = reconciler.handleEvent({ event: 'itemAdded', data: { revision: 3, item: 'c' } })
    expect(gapped.gap).toBeDefined()
    // Event still flows to event listeners...
    expect(gapped.deliveries).toHaveLength(1)
    // ...but state was NOT advanced past the gap.
    expect(reconciler.getState()).toEqual({ revision: 1, items: ['a'] })

    // The repair snapshot re-initializes state and lifts the suspension.
    reconciler.handleSnapshot({ revision: 3, items: ['a', 'b', 'c'] })
    expect(reconciler.getState()).toEqual({ revision: 3, items: ['a', 'b', 'c'] })
    reconciler.handleEvent({ event: 'itemAdded', data: { revision: 4, item: 'd' } })
    expect(reconciler.getState()).toEqual({ revision: 4, items: ['a', 'b', 'c', 'd'] })
  })

  it('reports the suspension so the caller can surface known-stale state', () => {
    const reconciler = stateReconciler()
    reconciler.handleSnapshot({ revision: 1, items: ['a'] })

    const gapped = reconciler.handleEvent({ event: 'itemAdded', data: { revision: 3, item: 'c' } })
    expect(gapped.stateSuspended).toBe(true)
    expect(reconciler.isStateSuspended).toBe(true)

    const repair = reconciler.handleSnapshot({ revision: 3, items: ['a', 'b', 'c'] })
    expect(repair.stateRepaired).toBe(true)
    expect(repair.stateSuspended).toBe(false)
    expect(reconciler.isStateSuspended).toBe(false)
  })

  it('lifts the suspension on a repair snapshot below the watermark', () => {
    const reconciler = stateReconciler()
    reconciler.handleSnapshot({ revision: 1, items: ['a'] })

    // Gap at revision 3 suspends state and moves the watermark to 3...
    reconciler.handleEvent({ event: 'itemAdded', data: { revision: 3, item: 'c' } })
    // ...and live events keep arriving while the repair poll is in flight, so
    // the watermark is at 5 by the time the snapshot for revision 4 lands.
    reconciler.handleEvent({ event: 'itemAdded', data: { revision: 4, item: 'd' } })
    reconciler.handleEvent({ event: 'itemAdded', data: { revision: 5, item: 'e' } })
    expect(reconciler.getState()).toEqual({ revision: 1, items: ['a'] })

    const repair = reconciler.handleSnapshot({ revision: 4, items: ['a', 'b', 'c', 'd'] })

    expect(repair.stale).toBe(true)
    expect(repair.stateRepaired).toBe(true)
    expect(reconciler.isStateSuspended).toBe(false)
    // Revision 5 was delivered while suspended and the snapshot predates it,
    // so it is replayed onto the repaired state instead of being lost.
    expect(reconciler.getState()).toEqual({ revision: 5, items: ['a', 'b', 'c', 'd', 'e'] })

    // apply is live again, and the watermark was not rewound.
    reconciler.handleEvent({ event: 'itemAdded', data: { revision: 6, item: 'f' } })
    expect(reconciler.getState()).toEqual({ revision: 6, items: ['a', 'b', 'c', 'd', 'e', 'f'] })
  })

  it('does not replay events the repair snapshot already covers', () => {
    const reconciler = stateReconciler()
    reconciler.handleSnapshot({ revision: 1, items: ['a'] })

    reconciler.handleEvent({ event: 'itemAdded', data: { revision: 3, item: 'c' } })
    reconciler.handleEvent({ event: 'itemAdded', data: { revision: 4, item: 'd' } })

    // The snapshot describes revision 4, so 'c' and 'd' are already in it.
    reconciler.handleSnapshot({ revision: 4, items: ['a', 'b', 'c', 'd'] })

    expect(reconciler.getState()).toEqual({ revision: 4, items: ['a', 'b', 'c', 'd'] })
  })

  it('holds the suspension when the replay buffer overflowed', () => {
    const reconciler = new Reconciler(stateConfig, { hydrationBufferLimit: 2 })
    reconciler.handleSnapshot({ revision: 1, items: ['a'] })

    // Gap at revision 3, then more events than the buffer holds.
    reconciler.handleEvent({ event: 'itemAdded', data: { revision: 3, item: 'c' } })
    reconciler.handleEvent({ event: 'itemAdded', data: { revision: 4, item: 'd' } })
    reconciler.handleEvent({ event: 'itemAdded', data: { revision: 5, item: 'e' } })

    // A below-watermark snapshot can no longer prove what it misses, so state
    // stays suspended rather than silently dropping revision 5.
    const stale = reconciler.handleSnapshot({ revision: 4, items: ['a', 'b', 'c', 'd'] })
    expect(stale.stateRepaired).toBe(false)
    expect(reconciler.isStateSuspended).toBe(true)
    expect(reconciler.getState()).toEqual({ revision: 1, items: ['a'] })

    // A snapshot that reaches the watermark covers everything the dropped
    // buffer held, so it repairs state with nothing left to replay.
    const covering = reconciler.handleSnapshot({
      revision: 5,
      items: ['a', 'b', 'c', 'd', 'e'],
    })
    expect(covering.stateRepaired).toBe(true)
    expect(reconciler.isStateSuspended).toBe(false)
    expect(reconciler.getState()).toEqual({ revision: 5, items: ['a', 'b', 'c', 'd', 'e'] })
  })

  it('does not double-apply snapshot-synthesized events to state', () => {
    type SnapEvents = { stateChanged: CounterSnapshot }
    const reconciler = new Reconciler<CounterSnapshot, SnapEvents, CounterState>(
      {
        snapshotEvent: 'stateChanged',
        version: { ofSnapshot: (s) => s.revision },
        state: {
          init: (s) => ({ revision: s.revision, items: [...s.items] }),
          apply: (state) => {
            throw new Error(
              `apply must not run for synthesized events (state rev ${state.revision})`,
            )
          },
        },
      },
      { hydrationBufferLimit: 10 },
    )

    const outcome = reconciler.handleSnapshot({ revision: 1, items: ['a'] })
    expect(outcome.deliveries).toEqual([
      { event: 'stateChanged', data: { revision: 1, items: ['a'] }, origin: 'poll' },
    ])
    expect(reconciler.getState()).toEqual({ revision: 1, items: ['a'] })
  })
})

describe('Reconciler — versionless mode', () => {
  it('delivers everything at-least-once and relies on termination for dedup', () => {
    const reconciler = new Reconciler<JobSnapshot, JobEvents, undefined>(
      { ...jobConfig, version: 'none' },
      { hydrationBufferLimit: 10 },
    )
    const first = reconciler.handleEvent({ event: 'progress', data: { percent: 10 } })
    const repeat = reconciler.handleEvent({ event: 'progress', data: { percent: 10 } })
    expect(first.deliveries).toHaveLength(1)
    expect(repeat.deliveries).toHaveLength(1) // at-least-once: no gate

    const done = reconciler.handleSnapshot({ status: 'completed', result: 'ok', version: 0 })
    expect(done.terminated).toBe(true)
    // The duplicate terminal from the other channel is dropped by termination.
    const lateDone = reconciler.handleEvent({ event: 'done', data: { result: 'ok' } })
    expect(lateDone.deliveries).toHaveLength(0)
  })
})

describe('defaultCompareVersions', () => {
  it('compares numbers numerically', () => {
    expect(defaultCompareVersions(2, 10)).toBe(-1)
    expect(defaultCompareVersions(10, 2)).toBe(1)
    expect(defaultCompareVersions(5, 5)).toBe(0)
  })

  it('compares numeric strings numerically (avoids "10" < "2")', () => {
    expect(defaultCompareVersions('2', '10')).toBe(-1)
    expect(defaultCompareVersions('10', '2')).toBe(1)
  })

  it('falls back to lexicographic for non-numeric strings', () => {
    expect(defaultCompareVersions('a', 'b')).toBe(-1)
    expect(defaultCompareVersions('b', 'a')).toBe(1)
    expect(defaultCompareVersions('a', 'a')).toBe(0)
  })
})

describe('Reconciler — default event versions from SSE ids', () => {
  it('orders createEventIdSequence ids, so dedup and the stale-poll guard work', () => {
    const reconciler = jobReconciler()

    const first = reconciler.handleEvent({
      event: 'progress',
      data: { percent: 10 },
      id: '1754838000000-000000000002',
    })
    const replayed = reconciler.handleEvent({
      event: 'progress',
      data: { percent: 10 },
      id: '1754838000000-000000000002',
    })
    const next = reconciler.handleEvent({
      event: 'progress',
      data: { percent: 20 },
      id: '1754838000000-000000000003',
    })

    expect(first.deliveries).toHaveLength(1)
    expect(replayed.duplicate).toBe(true)
    expect(replayed.deliveries).toHaveLength(0)
    expect(next.deliveries).toHaveLength(1)
  })

  it('treats a new epoch as newer, so a restarted counter is not read as duplicates', () => {
    const reconciler = jobReconciler()
    reconciler.handleEvent({
      event: 'progress',
      data: { percent: 90 },
      id: '1754838000000-000000000500',
    })
    const afterRestart = reconciler.handleEvent({
      event: 'progress',
      data: { percent: 5 },
      id: '1754839000000-000000000001',
    })

    expect(afterRestart.duplicate).toBe(false)
    expect(afterRestart.deliveries).toHaveLength(1)
  })

  it('carries no version for ids in other shapes (UUIDs are unique, not ordered)', () => {
    const reconciler = jobReconciler()
    reconciler.handleSnapshot({ status: 'pending', version: 5 })

    // With no extractable version the event is delivered rather than compared
    // against the watermark — at-least-once, never a silent random drop.
    const delivered = reconciler.handleEvent({
      event: 'progress',
      data: { percent: 10 },
      id: '123e4567-e89b-12d3-a456-426614174000',
    })
    expect(delivered.duplicate).toBe(false)
    expect(delivered.deliveries).toHaveLength(1)

    // ...and the watermark did not move, so a later snapshot still applies.
    const snapshot = reconciler.handleSnapshot({ status: 'completed', result: 'ok', version: 6 })
    expect(snapshot.stale).toBe(false)
  })

  it('detects gaps in sequence ids and reports an epoch change as a resync point', () => {
    const dense = jobReconciler({ version: { ofSnapshot: (s) => s.version, dense: true } })
    dense.handleEvent({ event: 'progress', data: { percent: 10 }, id: '100-000000000001' })

    const gapped = dense.handleEvent({
      event: 'progress',
      data: { percent: 30 },
      id: '100-000000000003',
    })
    expect(gapped.gap).toEqual({
      from: '100-000000000001',
      to: '100-000000000003',
      reason: 'sequence',
    })

    // Counters restart with the epoch, so nothing here measures how much was
    // missed. Staying silent applied deltas across a writer restart and let a
    // busy stream keep pushing the deadman out, so the repair never happened.
    const newEpoch = dense.handleEvent({
      event: 'progress',
      data: { percent: 40 },
      id: '200-000000000001',
    })
    expect(newEpoch.gap).toEqual({
      from: '100-000000000003',
      to: '200-000000000001',
      reason: 'epoch-change',
    })
    expect(newEpoch.deliveries).toHaveLength(1)
  })

  it('reports an epoch change even when versions are not dense', () => {
    // A skipped counter is only measurable when versions are dense, but an
    // epoch change is a restart either way.
    const sparse = jobReconciler({ version: { ofSnapshot: (s) => s.version } })
    sparse.handleEvent({ event: 'progress', data: { percent: 10 }, id: '100-000000000001' })

    const skipped = sparse.handleEvent({
      event: 'progress',
      data: { percent: 30 },
      id: '100-000000000009',
    })
    expect(skipped.gap).toBeUndefined()

    const newEpoch = sparse.handleEvent({
      event: 'progress',
      data: { percent: 40 },
      id: '200-000000000001',
    })
    expect(newEpoch.gap?.reason).toBe('epoch-change')
  })
})

describe('Reconciler — epoch regression', () => {
  it('resyncs instead of wedging when the writer moves to a LOWER epoch', () => {
    // The documented migration: createEventIdSequence seeds its epoch from
    // Date.now(), createRedisEventIdSequence defaults to '0'. Ranking the new
    // epoch as an older version dropped every event that followed, forever.
    const reconciler = jobReconciler()
    reconciler.handleEvent({
      event: 'progress',
      data: { percent: 10 },
      id: '1754838000000-000000000002',
    })

    const migrated = reconciler.handleEvent({
      event: 'progress',
      data: { percent: 20 },
      id: '0-000000000001',
    })
    expect(migrated.duplicate).toBe(false)
    expect(migrated.deliveries).toHaveLength(1)
    expect(migrated.gap).toEqual({
      from: '1754838000000-000000000002',
      to: '0-000000000001',
      reason: 'epoch-change',
    })

    // The new epoch is the ordering scope now: its counter keeps flowing, and
    // dedup works inside it.
    const next = reconciler.handleEvent({
      event: 'progress',
      data: { percent: 30 },
      id: '0-000000000002',
    })
    expect(next.deliveries).toHaveLength(1)
    expect(next.gap).toBeUndefined()
    const replayed = reconciler.handleEvent({
      event: 'progress',
      data: { percent: 30 },
      id: '0-000000000002',
    })
    expect(replayed.duplicate).toBe(true)
  })

  it('suspends the state layer on an epoch regression, like any other gap', () => {
    type Ledger = { revision: string; total: number }
    type LedgerEvents = { added: { amount: number } }
    const reconciler = new Reconciler<Ledger, LedgerEvents, number>(
      {
        version: { ofSnapshot: (s) => s.revision },
        state: {
          init: (s) => s.total,
          apply: (total, event) => total + (event.data as { amount: number }).amount,
        },
      },
      { hydrationBufferLimit: 3 },
    )
    reconciler.handleSnapshot({ revision: '900-000000000001', total: 10 })
    reconciler.handleEvent({ event: 'added', data: { amount: 5 }, id: '900-000000000002' })
    expect(reconciler.getState()).toBe(15)

    const migrated = reconciler.handleEvent({
      event: 'added',
      data: { amount: 7 },
      id: '0-000000000001',
    })
    expect(migrated.gap?.reason).toBe('epoch-change')
    expect(migrated.stateSuspended).toBe(true)
    expect(migrated.deliveries).toHaveLength(1)
    // Deltas are not applied across the re-scoping...
    expect(reconciler.getState()).toBe(15)

    // ...the repair snapshot from the new epoch rebuilds state.
    const repair = reconciler.handleSnapshot({ revision: '0-000000000001', total: 22 })
    expect(repair.stateRepaired).toBe(true)
    expect(reconciler.getState()).toBe(22)
    expect(reconciler.isStateSuspended).toBe(false)
  })

  it('honours a custom comparator rather than bypassing it on an epoch change', () => {
    // Declaring `version.compare` means owning ordering end to end, epochs
    // included: the bypass exists to correct the DEFAULT comparator, which is
    // the one that ranks by epoch.
    const reconciler = jobReconciler({
      version: {
        ofSnapshot: (s) => s.version,
        compare: (a, b) => (a === b ? 0 : String(a) < String(b) ? -1 : 1),
      },
    })
    reconciler.handleEvent({ event: 'progress', data: { percent: 10 }, id: '900-000000000002' })

    const lowerEpoch = reconciler.handleEvent({
      event: 'progress',
      data: { percent: 20 },
      id: '0-000000000001',
    })
    expect(lowerEpoch.duplicate).toBe(true)
    expect(lowerEpoch.gap).toBeUndefined()
  })

  it('accepts a snapshot from a new epoch instead of dropping it as stale', () => {
    // A poll-only subscription hits the same regression with no events at all.
    type Doc = { revision: string; body: string }
    type DocEvents = { changed: { body: string } }
    const reconciler = new Reconciler<Doc, DocEvents, undefined>(
      {
        snapshotToEvents: (s) => [{ event: 'changed', data: { body: s.body } }],
        version: { ofSnapshot: (s) => s.revision },
      },
      { hydrationBufferLimit: 3 },
    )
    reconciler.handleSnapshot({ revision: '900-000000000004', body: 'old' })

    const migrated = reconciler.handleSnapshot({ revision: '0-000000000001', body: 'new' })
    expect(migrated.stale).toBe(false)
    expect(migrated.advanced).toBe(true)
    expect(migrated.deliveries).toHaveLength(1)
  })
})

describe('Reconciler — unorderable versions', () => {
  it('degrades to at-least-once when ofSnapshot returns undefined', () => {
    const invalid: unknown[] = []
    const reconciler = new Reconciler<JobSnapshot, JobEvents, undefined>(jobConfig, {
      hydrationBufferLimit: 3,
      onInvalidVersion: (info) => invalid.push(info),
    })

    // A snapshot body that simply has no version field.
    const snapshot = reconciler.handleSnapshot({ status: 'pending' } as unknown as JobSnapshot)
    expect(snapshot.advanced).toBe(true)
    expect(invalid).toEqual([{ source: 'snapshot', value: undefined }])

    // The watermark was NOT poisoned: events still flow, and the gate still
    // works from the first orderable version onwards.
    const first = reconciler.handleEvent({ event: 'progress', data: { percent: 10 }, id: '7' })
    expect(first.duplicate).toBe(false)
    expect(first.deliveries).toHaveLength(1)
    const older = reconciler.handleEvent({ event: 'progress', data: { percent: 5 }, id: '6' })
    expect(older.duplicate).toBe(true)
    const newer = reconciler.handleEvent({ event: 'progress', data: { percent: 20 }, id: '8' })
    expect(newer.deliveries).toHaveLength(1)

    // A later snapshot is not compared against a poisoned watermark either.
    const later = reconciler.handleSnapshot({ status: 'completed', result: 'ok', version: 9 })
    expect(later.stale).toBe(false)
    expect(later.deliveries).toHaveLength(1)
  })

  it('rejects NaN, Infinity and empty-string versions', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, '', {}]) {
      const invalid: unknown[] = []
      const reconciler = new Reconciler<JobSnapshot, JobEvents, undefined>(
        { ...jobConfig, version: { ofSnapshot: () => value as number } },
        { hydrationBufferLimit: 3, onInvalidVersion: (info) => invalid.push(info) },
      )
      reconciler.handleSnapshot({ status: 'pending', version: 1 })
      expect(invalid).toEqual([{ source: 'snapshot', value }])

      const delivered = reconciler.handleEvent({
        event: 'progress',
        data: { percent: 10 },
        id: '1',
      })
      expect(delivered.duplicate).toBe(false)
      expect(delivered.deliveries).toHaveLength(1)
    }
  })

  it('reports an unorderable ofEvent result but keeps undefined silent', () => {
    const invalid: unknown[] = []
    const reconciler = new Reconciler<JobSnapshot, JobEvents, undefined>(
      {
        ...jobConfig,
        version: {
          ofSnapshot: (s) => s.version,
          ofEvent: (event) => (event.event === 'progress' ? Number.NaN : undefined),
        },
      },
      { hydrationBufferLimit: 3, onInvalidVersion: (info) => invalid.push(info) },
    )
    reconciler.handleSnapshot({ status: 'pending', version: 5 })

    const delivered = reconciler.handleEvent({ event: 'progress', data: { percent: 10 }, id: '6' })
    expect(delivered.deliveries).toHaveLength(1)
    expect(invalid).toEqual([{ source: 'event', value: Number.NaN }])

    // A documented "no version" answer is not a misconfiguration.
    invalid.length = 0
    reconciler.handleEvent({ event: 'done', data: { result: 'ok' } })
    expect(invalid).toEqual([])
  })
})

describe('Reconciler — gaps while flushing the hydration buffer', () => {
  it('reports a gap found in the flushed buffer so the caller polls', () => {
    const reconciler = jobReconciler({
      version: { ofSnapshot: (s) => s.version, dense: true },
    })
    reconciler.beginHydration()
    reconciler.handleEvent({ event: 'progress', data: { percent: 10 }, id: '6' })
    // 7 never arrived.
    reconciler.handleEvent({ event: 'progress', data: { percent: 30 }, id: '8' })

    const flushed = reconciler.handleSnapshot({ status: 'pending', version: 5 })
    expect(flushed.hydrationCompleted).toBe(true)
    expect(flushed.deliveries).toHaveLength(2)
    // The earliest hole: one repair poll covers every later one.
    expect(flushed.gap).toEqual({ from: 6, to: 8, reason: 'sequence' })
  })

  it('reports a gap found while abandoning hydration, with the state suspension', () => {
    type Ledger = { version: number; total: number }
    type LedgerEvents = { added: { amount: number } }
    const reconciler = new Reconciler<Ledger, LedgerEvents, number>(
      {
        version: { ofSnapshot: (s) => s.version, dense: true },
        state: {
          init: (s) => s.total,
          apply: (total, event) => total + (event.data as { amount: number }).amount,
        },
      },
      { hydrationBufferLimit: 5 },
    )
    reconciler.handleSnapshot({ version: 1, total: 0 })
    reconciler.beginHydration()
    reconciler.handleEvent({ event: 'added', data: { amount: 1 }, id: '2' })
    reconciler.handleEvent({ event: 'added', data: { amount: 1 }, id: '5' })

    const abandoned = reconciler.abandonHydration()
    expect(abandoned.deliveries).toHaveLength(2)
    expect(abandoned.gap).toEqual({ from: 2, to: 5, reason: 'sequence' })
    expect(abandoned.stateSuspended).toBe(true)
  })

  it('leaves gap undefined when the flush finds no hole', () => {
    const reconciler = jobReconciler({
      version: { ofSnapshot: (s) => s.version, dense: true },
    })
    reconciler.beginHydration()
    reconciler.handleEvent({ event: 'progress', data: { percent: 10 }, id: '6' })
    reconciler.handleEvent({ event: 'progress', data: { percent: 20 }, id: '7' })

    const flushed = reconciler.handleSnapshot({ status: 'pending', version: 5 })
    expect(flushed.deliveries).toHaveLength(2)
    expect(flushed.gap).toBeUndefined()
  })
})

describe('Reconciler — abandoning hydration', () => {
  it('flushes the buffered events instead of discarding them', () => {
    const reconciler = jobReconciler()
    reconciler.beginHydration()

    const buffered = reconciler.handleEvent({ event: 'progress', data: { percent: 10 }, id: '1' })
    expect(buffered.buffered).toBe(true)
    expect(buffered.deliveries).toHaveLength(0)

    const flushed = reconciler.abandonHydration()
    expect(flushed.deliveries).toEqual([
      { event: 'progress', data: { percent: 10 }, id: '1', origin: 'sse' },
    ])
    expect(reconciler.isHydrating).toBe(false)

    // Direct delivery resumes.
    const live = reconciler.handleEvent({ event: 'progress', data: { percent: 20 }, id: '2' })
    expect(live.deliveries).toHaveLength(1)
  })

  it('is a no-op when hydration is not in progress', () => {
    const reconciler = jobReconciler()
    expect(reconciler.abandonHydration().deliveries).toHaveLength(0)
  })
})

describe('defaultCompareVersions — sequence ids', () => {
  it('orders by counter within an epoch, beyond the zero padding width', () => {
    expect(defaultCompareVersions('100-000000000002', '100-000000000010')).toBe(-1)
    expect(defaultCompareVersions('100-9999999999999', '100-000000000010')).toBe(1)
    expect(defaultCompareVersions('100-000000000007', '100-000000000007')).toBe(0)
  })

  it('orders a newer epoch above an older one regardless of counter', () => {
    expect(defaultCompareVersions('100-000000000900', '200-000000000001')).toBe(-1)
    expect(defaultCompareVersions('200-000000000001', '100-000000000900')).toBe(1)
  })
})

describe('Reconciler — terminal events from a snapshot', () => {
  type MultiSnapshot = { version: number }
  type MultiEvents = { progress: { step: number }; done: { ok: true } }

  it('delivers nothing after the terminal event in the same snapshot', () => {
    const reconciler = new Reconciler<MultiSnapshot, MultiEvents, undefined>(
      {
        snapshotToEvents: () => [
          { event: 'progress', data: { step: 1 } },
          { event: 'done', data: { ok: true } },
          { event: 'progress', data: { step: 2 } },
        ],
        version: { ofSnapshot: (s) => s.version },
        terminalEvents: ['done'],
      },
      { hydrationBufferLimit: 10 },
    )

    const outcome = reconciler.handleSnapshot({ version: 1 })

    expect(outcome.terminated).toBe(true)
    expect(outcome.deliveries.map((d) => d.event)).toEqual(['progress', 'done'])
  })
})

describe('defaultCompareVersions — integers beyond MAX_SAFE_INTEGER', () => {
  it('orders adjacent unsafe integer strings instead of collapsing them', () => {
    // Both coerce to the same double, so a numeric comparison would call the
    // second one a duplicate of the first.
    expect(Number('9007199254740992')).toBe(Number('9007199254740993'))

    expect(defaultCompareVersions('9007199254740992', '9007199254740993')).toBe(-1)
    expect(defaultCompareVersions('9007199254740993', '9007199254740992')).toBe(1)
    expect(defaultCompareVersions('9007199254740993', '9007199254740993')).toBe(0)
  })

  it('does not drop an unsafe-integer event as a duplicate of its predecessor', () => {
    const reconciler = new Reconciler<
      { version: string },
      { tick: Record<string, never> },
      undefined
    >(
      { snapshotToEvents: () => [], version: { ofSnapshot: (s) => s.version } },
      { hydrationBufferLimit: 10 },
    )

    reconciler.handleEvent({ event: 'tick', data: {}, id: '9007199254740992' })
    const next = reconciler.handleEvent({ event: 'tick', data: {}, id: '9007199254740993' })

    expect(next.duplicate).toBe(false)
    expect(next.deliveries).toHaveLength(1)
  })
})
