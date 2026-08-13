import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FallbackBinding } from './binding.ts'
import type { FallbackBindingConfig, FallbackEvent, FallbackPolicy } from './bindingTypes.ts'
import { createResilientSubscription } from './subscription.ts'
import { type TestSnapshotCall, type TestStreamHandle, TestTransport } from './transport.ts'

type Snap = { status: 'pending' | 'completed'; result?: string; version: number }
type Events = { progress: { percent: number }; done: { result: string } }

const TEST_POLICY: Partial<FallbackPolicy> = {
  initialPoll: 'eager',
  deadmanDelayMs: 1_000,
  deadmanIdleBackoff: { factor: 1, maxMs: 1_000 },
  staleConnectionTimeoutMs: 5_000,
  pollFailureBackoff: { baseMs: 100, factor: 1, maxMs: 100 },
  sseRetryBackoff: { baseMs: 100, factor: 1, maxMs: 100 },
  degradedAfterFailures: 2,
  degradedPollIntervalMs: 2_000,
  degradedSseRetryMaxMs: 100,
  hydrationBufferLimit: 3,
}

function makeBinding(
  overrides?: Partial<FallbackBindingConfig<Snap, Events, undefined>>,
): FallbackBinding<Snap, Events, undefined> {
  return {
    config: {
      snapshotToEvents: (s) =>
        s.status === 'completed' ? [{ event: 'done', data: { result: s.result as string } }] : [],
      version: { ofSnapshot: (s) => s.version },
      terminalEvents: ['done'],
      ...overrides,
    },
    buildSnapshotRequest: () => ({ path: '/job', method: 'get' }),
    buildStreamRequest: () => ({ path: '/job', method: 'get' }),
  }
}

type Harness = {
  transport: TestTransport
  streams: TestStreamHandle[]
  snapshots: TestSnapshotCall[]
}

function makeHarness(): Harness {
  const transport = new TestTransport()
  const streams: TestStreamHandle[] = []
  const snapshots: TestSnapshotCall[] = []
  transport.onStreamConnect = (stream) => streams.push(stream)
  transport.onSnapshot = (call) => snapshots.push(call)
  return { transport, streams, snapshots }
}

const flush = () => vi.advanceTimersByTimeAsync(0)

describe('createResilientSubscription', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('use case A: SSE wins the race — the scheduled poll never fires again after the terminal event', async () => {
    const { transport, streams, snapshots } = makeHarness()
    const sub = createResilientSubscription(makeBinding(), {
      transport,
      policy: TEST_POLICY,
      random: () => 1,
    })
    const completion = sub.waitFor('done')
    await flush()

    expect(streams).toHaveLength(1)
    expect(snapshots).toHaveLength(1) // eager hydration poll
    snapshots[0]?.respond({ status: 'pending', version: 0 })
    await flush()
    expect(sub.status).toBe('live')

    streams[0]?.pushEvent('done', { result: 'ok' }, { id: '1' })
    await flush()

    await expect(completion).resolves.toEqual({ result: 'ok' })
    expect(sub.status).toBe('stopped')

    // All timers cancelled: no more polls, ever.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(transport.snapshotCalls).toHaveLength(1)
  })

  it('use case A: the deadman poll delivers the completion when SSE is silent', async () => {
    const { transport, snapshots } = makeHarness()
    const sub = createResilientSubscription(makeBinding(), {
      transport,
      policy: TEST_POLICY,
      random: () => 1,
    })
    const completion = sub.waitFor('done')
    const origins: string[] = []
    sub.onEvent((event) => origins.push(event.origin))
    await flush()
    snapshots[0]?.respond({ status: 'pending', version: 0 })
    await flush()

    // Silence — the deadman fires a reconciliation poll.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(snapshots).toHaveLength(2)
    snapshots[1]?.respond({ status: 'completed', result: 'late', version: 5 })
    await flush()

    await expect(completion).resolves.toEqual({ result: 'late' })
    expect(origins).toEqual(['poll'])
    expect(sub.status).toBe('stopped')
  })

  it('resets the deadman on data events but NOT on heartbeats', async () => {
    const { transport, streams, snapshots } = makeHarness()
    createResilientSubscription(makeBinding(), {
      transport,
      policy: TEST_POLICY,
      random: () => 1,
    })
    await flush()
    snapshots[0]?.respond({ status: 'pending', version: 0 })
    await flush()

    // A data event at t=800 resets the deadman...
    await vi.advanceTimersByTimeAsync(800)
    streams[0]?.pushEvent('progress', { percent: 10 }, { id: '1' })
    await flush()
    // ...so no poll at t=1000...
    await vi.advanceTimersByTimeAsync(800)
    expect(snapshots).toHaveLength(1)
    // ...but one at t=1800 (1000ms after the event).
    await vi.advanceTimersByTimeAsync(250)
    expect(snapshots).toHaveLength(2)
    snapshots[1]?.respond({ status: 'pending', version: 1 })
    await flush()

    // Heartbeats do NOT reset the deadman: transport liveness is not
    // delivery correctness — the fallback must fire even on healthy streams.
    await vi.advanceTimersByTimeAsync(800)
    streams[0]?.pushHeartbeat()
    await flush()
    await vi.advanceTimersByTimeAsync(250)
    expect(snapshots).toHaveLength(3)
  })

  it('force-closes a silently dead stream at staleConnectionTimeout and reconnects', async () => {
    const { transport, streams, snapshots } = makeHarness()
    const sub = createResilientSubscription(makeBinding(), {
      transport,
      policy: TEST_POLICY,
      random: () => 1,
    })
    await flush()
    snapshots[0]?.respond({ status: 'pending', version: 0 })
    await flush()
    expect(streams).toHaveLength(1)

    // Heartbeats keep the connection alive past the stale window...
    await vi.advanceTimersByTimeAsync(4_000)
    streams[0]?.pushHeartbeat()
    await flush()
    await vi.advanceTimersByTimeAsync(4_000)
    expect(transport.streamConnects).toHaveLength(1)

    // ...but total silence trips the watchdog: force-close + reconnect.
    await vi.advanceTimersByTimeAsync(1_200)
    await flush()
    expect(transport.streamConnects).toHaveLength(2)
    expect(sub.status).not.toBe('stopped')
  })

  it('drops a stale poll response arriving after a newer pushed event (cannot falsely complete)', async () => {
    const { transport, streams, snapshots } = makeHarness()
    const staleSnapshots: number[] = []
    const sub = createResilientSubscription(makeBinding(), {
      transport,
      policy: TEST_POLICY,
      random: () => 1,
      diagnostics: { onStaleSnapshot: () => staleSnapshots.push(1) },
    })
    await flush()
    snapshots[0]?.respond({ status: 'pending', version: 0 })
    await flush()

    // Deadman poll goes out but its response is slow...
    await vi.advanceTimersByTimeAsync(1_000)
    expect(snapshots).toHaveLength(2)

    // ...meanwhile SSE delivers version 10...
    streams[0]?.pushEvent('progress', { percent: 99 }, { id: '10' })
    await flush()

    // ...and the poll finally answers with an OLD completed snapshot (v9).
    snapshots[1]?.respond({ status: 'completed', result: 'STALE', version: 9 })
    await flush()

    expect(staleSnapshots).toHaveLength(1)
    // The stale snapshot did NOT complete the subscription.
    expect(sub.status).toBe('live')
  })

  it('sends Last-Event-ID on reconnect and issues a reconciliation poll (untrusted replay)', async () => {
    const { transport, streams, snapshots } = makeHarness()
    const sub = createResilientSubscription(makeBinding(), {
      transport,
      policy: TEST_POLICY,
      random: () => 1,
    })
    await flush()
    snapshots[0]?.respond({ status: 'pending', version: 0 })
    await flush()

    streams[0]?.pushEvent('progress', { percent: 50 }, { id: '7' })
    await flush()

    // Server closes the stream.
    streams[0]?.close()
    await flush()
    expect(sub.status).toBe('reconnecting')
    // Immediate reconciliation poll on drop.
    expect(snapshots).toHaveLength(2)
    snapshots[1]?.respond({ status: 'pending', version: 7 })

    // Reconnect happens after the retry backoff, carrying Last-Event-ID.
    await vi.advanceTimersByTimeAsync(150)
    expect(streams).toHaveLength(2)
    expect(streams[1]?.lastEventIdReceived).toBe('7')
    expect(sub.status).toBe('live')

    // Another poll after the reconnect (untrusted replay).
    await flush()
    expect(snapshots.length).toBeGreaterThanOrEqual(3)
  })

  it('degrades to POLLING_ONLY after repeated connect failures and recovers when SSE returns', async () => {
    const { transport, streams, snapshots } = makeHarness()
    transport.denyNextStreamConnect({ error: new Error('refused') })
    transport.denyNextStreamConnect({ error: new Error('refused') })

    const sub = createResilientSubscription(makeBinding(), {
      transport,
      policy: TEST_POLICY,
      random: () => 1,
    })
    await flush()
    // First connect failed; retry after backoff; second fails too → degraded.
    await vi.advanceTimersByTimeAsync(150)
    await flush()
    expect(sub.status).toBe('polling')

    // Polls keep flowing while degraded.
    for (const call of [...snapshots]) call.respond({ status: 'pending', version: 0 })
    snapshots.length = 0
    await vi.advanceTimersByTimeAsync(2_100)
    expect(snapshots.length).toBeGreaterThanOrEqual(1)
    for (const call of [...snapshots]) call.respond({ status: 'pending', version: 0 })

    // Background SSE retry eventually reconnects; the (first successful)
    // connect starts eager hydration — answering its snapshot goes live.
    await vi.advanceTimersByTimeAsync(200)
    await flush()
    expect(streams.length).toBeGreaterThanOrEqual(1)
    for (const call of [...snapshots]) call.respond({ status: 'pending', version: 0 })
    await flush()
    expect(sub.status).toBe('live')
  })

  it('stops on unretryable poll statuses (404)', async () => {
    const { transport, snapshots } = makeHarness()
    const sub = createResilientSubscription(makeBinding(), {
      transport,
      policy: TEST_POLICY,
      random: () => 1,
    })
    const completion = sub.waitFor('done')
    completion.catch(() => {}) // assertion below; avoid unhandled rejection
    await flush()

    snapshots[0]?.respond({ error: 'not found' }, 404)
    await flush()

    expect(sub.status).toBe('stopped')
    await expect(completion).rejects.toThrow(/stopped/)
  })

  it('hydrates subscribe-first: buffers live events, snapshot first, then only newer events', async () => {
    const { transport, streams, snapshots } = makeHarness()
    const delivered: Array<FallbackEvent<Events>> = []
    const sub = createResilientSubscription(makeBinding(), {
      transport,
      policy: TEST_POLICY,
      random: () => 1,
    })
    sub.onEvent((event) => delivered.push(event))
    await flush()
    expect(sub.status).toBe('connecting')

    // Live events arrive while the hydration snapshot is still in flight.
    streams[0]?.pushEvent('progress', { percent: 40 }, { id: '4' })
    streams[0]?.pushEvent('progress', { percent: 60 }, { id: '6' })
    await flush()
    expect(delivered).toHaveLength(0) // buffered

    // Snapshot at v5 subsumes v4; v6 is flushed after it.
    snapshots[0]?.respond({ status: 'pending', version: 5 })
    await flush()

    expect(sub.status).toBe('live')
    expect(delivered).toEqual([
      { event: 'progress', data: { percent: 60 }, id: '6', origin: 'sse' },
    ])
  })

  it('polls immediately on a version gap (dense mode) instead of waiting for the deadman', async () => {
    const { transport, streams, snapshots } = makeHarness()
    const gaps: Array<{ from: unknown; to: unknown }> = []
    createResilientSubscription(
      makeBinding({ version: { ofSnapshot: (s) => s.version, dense: true } }),
      {
        transport,
        policy: TEST_POLICY,
        random: () => 1,
        diagnostics: { onGap: (gap) => gaps.push(gap) },
      },
    )
    await flush()
    snapshots[0]?.respond({ status: 'pending', version: 1 })
    await flush()

    // Version 3 arrives without 2 — the repair poll fires with NO timer advance.
    streams[0]?.pushEvent('progress', { percent: 30 }, { id: '3' })
    await flush()

    expect(gaps).toEqual([{ from: 1, to: 3 }])
    expect(snapshots).toHaveLength(2)
  })

  it('exposes a uniform async-iterable regardless of the delivering channel', async () => {
    const { transport, streams, snapshots } = makeHarness()
    const sub = createResilientSubscription(makeBinding(), {
      transport,
      policy: TEST_POLICY,
      random: () => 1,
    })
    const collected: Array<FallbackEvent<Events>> = []
    const iteration = (async () => {
      for await (const event of sub.events()) {
        collected.push(event)
      }
    })()

    await flush()
    snapshots[0]?.respond({ status: 'pending', version: 0 })
    await flush()

    streams[0]?.pushEvent('progress', { percent: 10 }, { id: '1' })
    await flush()

    await vi.advanceTimersByTimeAsync(1_000)
    snapshots[1]?.respond({ status: 'completed', result: 'ok', version: 2 })
    await flush()

    await iteration // completes on the terminal event
    expect(collected).toEqual([
      { event: 'progress', data: { percent: 10 }, id: '1', origin: 'sse' },
      { event: 'done', data: { result: 'ok' }, origin: 'poll' },
    ])
  })

  it('stop() aborts in-flight work and completes iterators', async () => {
    const { transport, snapshots } = makeHarness()
    const sub = createResilientSubscription(makeBinding(), {
      transport,
      policy: TEST_POLICY,
      random: () => 1,
    })
    const iteration = (async () => {
      const seen: unknown[] = []
      for await (const event of sub.events()) seen.push(event)
      return seen
    })()
    await flush()
    expect(snapshots).toHaveLength(1)

    sub.stop()
    await expect(iteration).resolves.toEqual([])
    expect(sub.status).toBe('stopped')

    await vi.advanceTimersByTimeAsync(60_000)
    expect(transport.snapshotCalls).toHaveLength(1)
    expect(transport.streamConnects).toHaveLength(1)
  })
})
