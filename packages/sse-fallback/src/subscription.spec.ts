import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FallbackBinding } from './binding.ts'
import type { FallbackBindingConfig, FallbackEvent, FallbackPolicy } from './bindingTypes.ts'
import { createPollGate } from './pollGate.ts'
import {
  createResilientSubscription,
  type SubscriptionStopDetail,
  SubscriptionStoppedError,
} from './subscription.ts'
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
    // Hydration is done, but the stream has produced no bytes yet: response
    // headers are not delivery, so this is still 'connecting'.
    expect(sub.status).toBe('connecting')

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

    // Background SSE retry eventually reconnects and its connect starts eager
    // hydration. Answering that snapshot does not go live on its own: bytes
    // off the reconnected stream are what leave degraded mode.
    await vi.advanceTimersByTimeAsync(200)
    await flush()
    expect(streams.length).toBeGreaterThanOrEqual(1)
    for (const call of [...snapshots]) call.respond({ status: 'pending', version: 0 })
    await flush()
    expect(sub.status).toBe('polling')

    streams.at(-1)?.pushHeartbeat()
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

  it('does not report a byte-less stream as live when hydration completes', async () => {
    const { transport, streams, snapshots } = makeHarness()
    const sub = createResilientSubscription(makeBinding(), {
      transport,
      policy: TEST_POLICY,
      random: () => 1,
    })
    await flush()
    expect(sub.status).toBe('connecting')

    // The stream is accepted (headers only) and the hydration snapshot lands.
    // Headers are not delivery: nothing has come down the stream yet.
    snapshots[0]?.respond({ status: 'pending', version: 1 })
    await flush()
    expect(sub.status).toBe('connecting')

    // The first real bytes are what earn 'live'.
    streams[0]?.pushHeartbeat()
    await flush()
    expect(sub.status).toBe('live')
  })

  it('does not let duplicate events hold off the reconciliation poll', async () => {
    const { transport, streams, snapshots } = makeHarness()
    createResilientSubscription(makeBinding(), {
      transport,
      policy: TEST_POLICY,
      random: () => 1,
    })
    await flush()
    snapshots[0]?.respond({ status: 'pending', version: 5 })
    await flush()

    // Frames below the watermark deliver nothing, so they must not push the
    // reconciliation poll out: a flood of them would suppress it forever.
    for (let i = 0; i < 3; i += 1) {
      await vi.advanceTimersByTimeAsync(300)
      streams[0]?.pushEvent('progress', { percent: 10 }, { id: '3' })
      await flush()
    }

    await vi.advanceTimersByTimeAsync(150)
    expect(snapshots).toHaveLength(2)
  })

  it('lets the idle backoff keep growing while the stream keeps delivering', async () => {
    const { transport, streams, snapshots } = makeHarness()
    createResilientSubscription(makeBinding(), {
      transport,
      policy: { ...TEST_POLICY, deadmanIdleBackoff: { factor: 2, maxMs: 8_000 } },
      random: () => 1,
    })
    await flush()
    // Hydration poll carried no news, so the deadman stretches to 2s.
    snapshots[0]?.respond({ status: 'pending', version: 0 })
    await flush()

    await vi.advanceTimersByTimeAsync(2_000)
    expect(snapshots).toHaveLength(2)
    // Still no news: the next reconciliation is 4s out.
    snapshots[1]?.respond({ status: 'pending', version: 1 })
    await flush()

    // A delivered event pushes that poll out, at the interval the backoff has
    // reached. Pulling it back to deadmanDelayMs would poll between nearly
    // every pair of events on a healthy stream.
    await vi.advanceTimersByTimeAsync(1_000)
    streams[0]?.pushEvent('progress', { percent: 20 }, { id: '2' })
    await flush()

    await vi.advanceTimersByTimeAsync(2_000)
    expect(snapshots).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(snapshots).toHaveLength(3)
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

    expect(gaps).toEqual([{ from: 1, to: 3, reason: 'sequence' }])
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

describe('createResilientSubscription — liveness and failure bounds', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('bounds a hung stream connect so polling still happens', async () => {
    const { transport, snapshots } = makeHarness()
    transport.holdNextStreamConnect()
    const sub = createResilientSubscription(makeBinding(), {
      transport,
      policy: { ...TEST_POLICY, connectTimeoutMs: 3_000 },
      random: () => 1,
    })
    await flush()

    // Headers never arrive: nothing has been polled and nothing is armed yet.
    expect(snapshots).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(3_000)
    // The connect was abandoned, counted as a failure, and repaired by a poll.
    expect(snapshots.length).toBeGreaterThanOrEqual(1)
    expect(sub.status).not.toBe('live')

    snapshots[0]?.respond({ status: 'completed', result: 'via poll', version: 1 })
    await flush()
    expect(sub.status).toBe('stopped')
  })

  it('counts a connect that closes without bytes as a failure and degrades', async () => {
    const { transport, streams, snapshots } = makeHarness()
    const sub = createResilientSubscription(makeBinding(), {
      transport,
      policy: TEST_POLICY,
      random: () => 1,
    })
    await flush()
    snapshots[0]?.respond({ status: 'pending', version: 0 })
    await flush()

    // Every reconnect is accepted and then closed immediately, delivering
    // nothing. Without byte-gated success this loops forever at attempt 0.
    for (let i = 0; i < 4; i++) {
      streams[streams.length - 1]?.close()
      await vi.advanceTimersByTimeAsync(200)
    }

    expect(sub.status).toBe('polling')
  })

  it('releases the response of a refused connect instead of leaking it', async () => {
    const { transport, snapshots } = makeHarness()
    transport.denyNextStreamConnect({ status: 502 })
    createResilientSubscription(makeBinding(), {
      transport,
      policy: TEST_POLICY,
      random: () => 1,
    })
    await flush()

    expect(transport.deniedConnectAborts).toEqual([true])
    expect(snapshots.length).toBeGreaterThanOrEqual(1)
  })

  it('clamps a server retry hint instead of using it verbatim', async () => {
    const { transport, streams, snapshots } = makeHarness()
    createResilientSubscription(makeBinding(), {
      transport,
      policy: { ...TEST_POLICY, serverRetryHintBounds: { minMs: 500, maxMs: 2_000 } },
      random: () => 1,
    })
    await flush()
    snapshots[0]?.respond({ status: 'pending', version: 0 })
    await flush()

    // `retry: 0` would otherwise spin a zero-delay reconnect loop.
    streams[0]?.pushEvent('progress', { percent: 10 }, { id: '1', retry: 0 })
    await flush()
    streams[0]?.close()
    await flush()

    expect(transport.streamConnects).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(499)
    expect(transport.streamConnects).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(transport.streamConnects).toHaveLength(2)
  })

  it('honors a retry hint from a frame that carries no data', async () => {
    const { transport, streams, snapshots } = makeHarness()
    createResilientSubscription(makeBinding(), {
      transport,
      policy: { ...TEST_POLICY, serverRetryHintBounds: { minMs: 500, maxMs: 5_000 } },
      random: () => 1,
    })
    await flush()
    snapshots[0]?.respond({ status: 'pending', version: 0 })
    await flush()

    // No `data:` field, so the frame dispatches no event. The reconnect delay
    // still has to move, or a server cannot revise it on a quiet stream.
    streams[0]?.pushRaw('retry: 3000\n\n')
    await flush()
    streams[0]?.close()
    await flush()

    expect(transport.streamConnects).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2_999)
    expect(transport.streamConnects).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(transport.streamConnects).toHaveLength(2)
  })

  it('bounds a poll that never settles so the deadman keeps polling', async () => {
    const { transport, snapshots } = makeHarness()
    createResilientSubscription(makeBinding(), {
      transport,
      policy: { ...TEST_POLICY, pollTimeoutMs: 2_000 },
      random: () => 1,
    })
    await flush()
    expect(snapshots).toHaveLength(1) // hydration poll — never answered

    await vi.advanceTimersByTimeAsync(2_000)
    // The abandoned poll released the in-flight latch and re-armed the deadman.
    await vi.advanceTimersByTimeAsync(100)
    expect(snapshots.length).toBeGreaterThanOrEqual(2)
  })

  it('abandons hydration after repeated poll failures so the stream is not silenced', async () => {
    const { transport, streams, snapshots } = makeHarness()
    const sub = createResilientSubscription(makeBinding(), {
      transport,
      policy: { ...TEST_POLICY, hydrationAbandonAfterFailures: 2 },
      random: () => 1,
    })
    const delivered: Array<FallbackEvent<Events>> = []
    sub.onEvent((event) => delivered.push(event))
    await flush()

    // The snapshot endpoint is down; the stream is perfectly healthy.
    snapshots[0]?.fail()
    await flush()
    streams[0]?.pushEvent('progress', { percent: 50 }, { id: '1' })
    await flush()
    expect(delivered).toHaveLength(0) // buffered by hydration

    await vi.advanceTimersByTimeAsync(100)
    snapshots[1]?.fail()
    await flush()

    // Hydration gave up: the buffered event reaches the application.
    expect(delivered.map((event) => event.event)).toEqual(['progress'])

    streams[0]?.pushEvent('progress', { percent: 80 }, { id: '2' })
    await flush()
    expect(delivered).toHaveLength(2)
  })

  it('repairs an undecodable frame by polling and does not skip it on replay', async () => {
    const { transport, streams, snapshots } = makeHarness()
    createResilientSubscription(makeBinding(), {
      transport,
      policy: TEST_POLICY,
      random: () => 1,
    })
    await flush()
    snapshots[0]?.respond({ status: 'pending', version: 0 })
    await flush()

    streams[0]?.pushRaw('id: 7\ndata: not-json\n\n')
    await flush()

    // The lost event is repaired by a poll...
    expect(snapshots).toHaveLength(2)
    snapshots[1]?.respond({ status: 'pending', version: 0 })
    await flush()

    // ...and the watermark for replay did not move past the event we never read.
    streams[0]?.fail()
    await vi.advanceTimersByTimeAsync(200)
    // Assert the reconnect happened first: without this, a regression that
    // stops reconnecting leaves streams[1] undefined and the check below
    // passes vacuously.
    expect(streams).toHaveLength(2)
    expect(streams[1]?.lastEventIdReceived).toBeUndefined()
  })

  it('decodes non-JSON payloads through a custom parseEventData', async () => {
    const { transport, streams, snapshots } = makeHarness()
    const sub = createResilientSubscription(makeBinding(), {
      transport,
      policy: TEST_POLICY,
      random: () => 1,
      parseEventData: (raw) => ({ result: raw }),
    })
    const completion = sub.waitFor('done')
    await flush()
    snapshots[0]?.respond({ status: 'pending', version: 0 })
    await flush()

    streams[0]?.pushRaw('id: 1\nevent: done\ndata: plain-text-payload\n\n')
    await flush()

    await expect(completion).resolves.toEqual({ result: 'plain-text-payload' })
  })
})

describe('createResilientSubscription — stop reasons', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports a terminal event as success, not as a bare stop', async () => {
    const { transport, streams, snapshots } = makeHarness()
    const sub = createResilientSubscription(makeBinding(), {
      transport,
      policy: TEST_POLICY,
      random: () => 1,
    })
    const stops: SubscriptionStopDetail[] = []
    sub.onStop((detail) => stops.push(detail))
    await flush()
    snapshots[0]?.respond({ status: 'pending', version: 0 })
    await flush()

    streams[0]?.pushEvent('done', { result: 'ok' }, { id: '1' })
    await flush()

    expect(sub.result).toEqual({ reason: 'terminal-event' })
    expect(stops).toEqual([{ reason: 'terminal-event' }])
  })

  it('distinguishes an auth failure from a completed subscription', async () => {
    const { transport, snapshots } = makeHarness()
    const sub = createResilientSubscription(makeBinding(), {
      transport,
      policy: TEST_POLICY,
      random: () => 1,
    })
    const completion = sub.waitFor('done').catch((error: unknown) => error)
    await flush()
    snapshots[0]?.respond({}, 401)
    await flush()

    const error = await completion
    expect(error).toBeInstanceOf(SubscriptionStoppedError)
    expect(error).toMatchObject({
      reason: 'unretryable-status',
      status: 401,
      channel: 'poll',
    })
    expect(sub.result?.reason).toBe('unretryable-status')
  })

  it('reports a caller stop() as manual', async () => {
    const { transport } = makeHarness()
    const sub = createResilientSubscription(makeBinding(), {
      transport,
      policy: TEST_POLICY,
      random: () => 1,
    })
    await flush()
    sub.stop()

    expect(sub.result).toEqual({ reason: 'manual' })
  })

  it('delivers the reason to onStatusChange and to a late onStop listener', async () => {
    const { transport } = makeHarness()
    const sub = createResilientSubscription(makeBinding(), {
      transport,
      policy: TEST_POLICY,
      random: () => 1,
    })
    const seen: Array<[string, SubscriptionStopDetail | undefined]> = []
    sub.onStatusChange((status, detail) => seen.push([status, detail]))
    await flush()
    sub.stop()

    expect(seen.at(-1)).toEqual(['stopped', { reason: 'manual' }])

    const late: SubscriptionStopDetail[] = []
    sub.onStop((detail) => late.push(detail))
    expect(late).toEqual([{ reason: 'manual' }])
  })
})

describe('createResilientSubscription — subscription budget', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('gives up on a permanently pending backend after maxDurationMs', async () => {
    const { transport, streams, snapshots } = makeHarness()
    const sub = createResilientSubscription(makeBinding(), {
      transport,
      policy: { ...TEST_POLICY, subscriptionBudget: { maxDurationMs: 5_000 } },
      random: () => 1,
    })
    const completion = sub.waitFor('done').catch((error: unknown) => error)
    await flush()
    snapshots[0]?.respond({ status: 'pending', version: 0 })
    await flush()
    expect(streams).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(5_000)

    expect(sub.result).toEqual({ reason: 'budget-exhausted', limit: 'maxDurationMs' })
    expect(await completion).toMatchObject({ reason: 'budget-exhausted' })

    // The machinery is fully shut down: no deadman poll behind the budget.
    const pollsAtStop = transport.snapshotCalls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(transport.snapshotCalls).toHaveLength(pollsAtStop)
  })

  it('gives up after maxPolls instead of deadman-polling forever', async () => {
    const { transport, snapshots } = makeHarness()
    const sub = createResilientSubscription(makeBinding(), {
      transport,
      policy: { ...TEST_POLICY, subscriptionBudget: { maxPolls: 3 } },
      random: () => 1,
    })
    await flush()

    for (let i = 0; i < 5; i++) {
      snapshots[i]?.respond({ status: 'pending', version: 0 })
      await vi.advanceTimersByTimeAsync(1_000)
    }

    expect(transport.snapshotCalls).toHaveLength(3)
    expect(sub.result).toEqual({ reason: 'budget-exhausted', limit: 'maxPolls' })
  })

  it('runs unbounded by default, so live-state surfaces keep their semantics', async () => {
    const { transport, snapshots } = makeHarness()
    const sub = createResilientSubscription(makeBinding(), {
      transport,
      policy: TEST_POLICY,
      random: () => 1,
    })
    await flush()
    snapshots[0]?.respond({ status: 'pending', version: 0 })

    await vi.advanceTimersByTimeAsync(60_000)

    expect(transport.snapshotCalls.length).toBeGreaterThan(3)
    expect(sub.result).toBeUndefined()
  })
})

describe('createResilientSubscription — auth challenge', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('refreshes credentials and retries the refused poll once', async () => {
    const { transport, snapshots } = makeHarness()
    const challenges: Array<{ status: number; channel: string }> = []
    const sub = createResilientSubscription(makeBinding(), {
      transport,
      policy: TEST_POLICY,
      random: () => 1,
      onAuthChallenge: (challenge) => {
        challenges.push(challenge)
        return true
      },
    })
    await flush()

    snapshots[0]?.respond({}, 401)
    await flush()

    expect(challenges).toEqual([{ status: 401, channel: 'poll' }])
    expect(snapshots).toHaveLength(2)
    expect(sub.status).not.toBe('stopped')

    snapshots[1]?.respond({ status: 'pending', version: 0 })
    await flush()
    expect(sub.result).toBeUndefined()
  })

  it('stops on a second auth refusal with no success in between', async () => {
    const { transport, snapshots } = makeHarness()
    const sub = createResilientSubscription(makeBinding(), {
      transport,
      policy: TEST_POLICY,
      random: () => 1,
      onAuthChallenge: () => true,
    })
    await flush()

    snapshots[0]?.respond({}, 401)
    await flush()
    snapshots[1]?.respond({}, 401)
    await flush()

    expect(sub.result).toEqual({ reason: 'unretryable-status', status: 401, channel: 'poll' })
  })

  it('stops immediately when the hook declines to refresh', async () => {
    const { transport, snapshots } = makeHarness()
    const sub = createResilientSubscription(makeBinding(), {
      transport,
      policy: TEST_POLICY,
      random: () => 1,
      onAuthChallenge: () => false,
    })
    await flush()

    snapshots[0]?.respond({}, 401)
    await flush()

    expect(snapshots).toHaveLength(1)
    expect(sub.result?.reason).toBe('unretryable-status')
  })

  it('does not offer non-auth unretryable statuses to the hook', async () => {
    const { transport, snapshots } = makeHarness()
    let called = false
    const sub = createResilientSubscription(makeBinding(), {
      transport,
      policy: TEST_POLICY,
      random: () => 1,
      onAuthChallenge: () => {
        called = true
        return true
      },
    })
    await flush()

    snapshots[0]?.respond({}, 404)
    await flush()

    expect(called).toBe(false)
    expect(sub.result).toEqual({ reason: 'unretryable-status', status: 404, channel: 'poll' })
  })

  it('lets a concurrent 401 join the in-flight refresh instead of killing the subscription', async () => {
    // Both channels see the same expired token. The poll starts the refresh
    // and the reconnect is refused while it is still running; counting that as
    // the second failure stopped the subscription mid-refresh.
    const { transport, streams, snapshots } = makeHarness()
    let release: (() => void) | undefined
    let challenges = 0
    const sub = createResilientSubscription(makeBinding(), {
      transport,
      policy: TEST_POLICY,
      random: () => 1,
      onAuthChallenge: () => {
        challenges += 1
        return new Promise<boolean>((resolve) => {
          release = () => resolve(true)
        })
      },
    })
    await flush()
    expect(snapshots).toHaveLength(1)

    snapshots[0]?.respond({}, 401)
    await flush()
    expect(challenges).toBe(1)

    transport.denyNextStreamConnect({ status: 401 })
    streams[0]?.close()
    await vi.advanceTimersByTimeAsync(500)

    // One refresh, shared: the reconnect's refusal waited for it.
    expect(challenges).toBe(1)
    expect(sub.result).toBeUndefined()

    release?.()
    await vi.advanceTimersByTimeAsync(500)

    expect(sub.result).toBeUndefined()
    expect(snapshots.length).toBeGreaterThan(1)
  })

  it('still stops on a refusal that arrives after the refresh completed', async () => {
    const { transport, snapshots } = makeHarness()
    const sub = createResilientSubscription(makeBinding(), {
      transport,
      policy: TEST_POLICY,
      random: () => 1,
      onAuthChallenge: () => Promise.resolve(true),
    })
    await flush()

    snapshots[0]?.respond({}, 401)
    await flush()
    snapshots[1]?.respond({}, 401)
    await flush()

    expect(sub.result).toEqual({ reason: 'unretryable-status', status: 401, channel: 'poll' })
  })

  it('recovers a stream connect refused with 401', async () => {
    const { transport, snapshots } = makeHarness()
    transport.denyNextStreamConnect({ status: 401 })
    const sub = createResilientSubscription(makeBinding(), {
      transport,
      policy: { ...TEST_POLICY, initialPoll: 'delayed' },
      random: () => 1,
      onAuthChallenge: () => true,
    })
    await vi.advanceTimersByTimeAsync(200)

    expect(transport.streamConnects.length).toBeGreaterThan(1)
    expect(sub.result).toBeUndefined()
    expect(snapshots.length).toBeGreaterThan(0)
  })
})

describe('createResilientSubscription — poll-only mode', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('never opens a stream and polls on the degraded cadence', async () => {
    const { transport, snapshots } = makeHarness()
    const sub = createResilientSubscription(makeBinding(), {
      transport,
      policy: { ...TEST_POLICY, mode: 'poll-only' },
      random: () => 1,
    })
    await flush()

    expect(transport.streamConnects).toHaveLength(0)
    expect(sub.status).toBe('polling')
    expect(snapshots).toHaveLength(1)

    snapshots[0]?.respond({ status: 'pending', version: 0 })
    await vi.advanceTimersByTimeAsync(2_000)

    expect(transport.streamConnects).toHaveLength(0)
    expect(transport.snapshotCalls).toHaveLength(2)
  })

  it('delivers poll-synthesized events and terminates on the terminal event', async () => {
    const { transport, snapshots } = makeHarness()
    const sub = createResilientSubscription(makeBinding(), {
      transport,
      policy: { ...TEST_POLICY, mode: 'poll-only' },
      random: () => 1,
    })
    const completion = sub.waitFor('done')
    await flush()

    snapshots[0]?.respond({ status: 'completed', result: 'ok', version: 1 })
    await flush()

    await expect(completion).resolves.toEqual({ result: 'ok' })
    expect(sub.result).toEqual({ reason: 'terminal-event' })
    expect(transport.streamConnects).toHaveLength(0)
  })
})

describe('createResilientSubscription — parsed-event transports', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('delivers events from a transport that only exposes parsed frames', async () => {
    const { transport, streams, snapshots } = makeHarness()
    transport.streamMode = 'parsed'
    const sub = createResilientSubscription(makeBinding(), {
      transport,
      policy: TEST_POLICY,
      random: () => 1,
    })
    const completion = sub.waitFor('done')
    await flush()
    snapshots[0]?.respond({ status: 'pending', version: 0 })
    await flush()

    streams[0]?.pushEvent('done', { result: 'ok' }, { id: '1' })
    await flush()

    await expect(completion).resolves.toEqual({ result: 'ok' })
  })

  it('degrades liveness to event level, so heartbeat comments cannot hold it open', async () => {
    const { transport, streams, snapshots } = makeHarness()
    transport.streamMode = 'parsed'
    createResilientSubscription(makeBinding(), {
      transport,
      policy: { ...TEST_POLICY, initialPoll: 'delayed', staleConnectionTimeoutMs: 5_000 },
      random: () => 1,
    })
    await flush()
    expect(streams).toHaveLength(1)

    // A comment frame never reaches a parsed transport's consumer, so it
    // cannot reset the watchdog the way a raw chunk does.
    streams[0]?.pushHeartbeat()
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(200)

    expect(streams.length).toBeGreaterThan(1)
    expect(snapshots.length).toBeGreaterThan(0)
  })
})

describe('createResilientSubscription — listener isolation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps delivering to the other listeners when one throws', async () => {
    const { transport, streams, snapshots } = makeHarness()
    const errors: unknown[] = []
    const streamErrors: unknown[] = []
    const seen: string[] = []
    const sub = createResilientSubscription(makeBinding({ terminalEvents: [] }), {
      transport,
      policy: TEST_POLICY,
      random: () => 1,
      diagnostics: {
        onListenerError: (error) => errors.push(error),
        onStreamError: (error) => streamErrors.push(error),
      },
    })
    sub.onEvent(() => {
      throw new Error('listener bug')
    })
    sub.onEvent((event) => seen.push(event.event))
    await flush()
    snapshots[0]?.respond({ status: 'pending', version: 0 })
    await flush()

    streams[0]?.pushEvent('progress', { percent: 10 }, { id: '1' })
    await flush()

    expect(seen).toEqual(['progress'])
    expect(errors).toHaveLength(1)
    // The application bug did not surface as a transport failure.
    expect(streamErrors).toEqual([])
    expect(sub.status).toBe('live')
  })

  it('does not let a throwing listener stall the events() iterator', async () => {
    const { transport, streams, snapshots } = makeHarness()
    const sub = createResilientSubscription(makeBinding({ terminalEvents: [] }), {
      transport,
      policy: TEST_POLICY,
      random: () => 1,
      diagnostics: { onListenerError: () => {} },
    })
    sub.onEvent(() => {
      throw new Error('listener bug')
    })
    const iterator = sub.events()[Symbol.asyncIterator]()
    const first = iterator.next()
    await flush()
    snapshots[0]?.respond({ status: 'pending', version: 0 })
    await flush()

    streams[0]?.pushEvent('progress', { percent: 10 }, { id: '1' })
    await flush()

    await expect(first).resolves.toMatchObject({ done: false, value: { event: 'progress' } })
  })
})

describe('createResilientSubscription — gaps found while flushing hydration', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports the gap and polls immediately, like a gap on a live event', async () => {
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

    // Both arrive while the hydration snapshot is still in flight, so they are
    // buffered and only meet the version gate when the buffer is flushed.
    streams[0]?.pushEvent('progress', { percent: 60 }, { id: '6' })
    streams[0]?.pushEvent('progress', { percent: 80 }, { id: '8' })
    await flush()
    expect(snapshots).toHaveLength(1)

    snapshots[0]?.respond({ status: 'pending', version: 5 })
    await flush()

    expect(gaps).toEqual([{ from: 6, to: 8, reason: 'sequence' }])
    // The repair poll fires with NO timer advance.
    expect(snapshots).toHaveLength(2)
  })

  it('reports a gap found while abandoning hydration without an extra poll', async () => {
    const { transport, streams, snapshots } = makeHarness()
    const gaps: Array<{ from: unknown; to: unknown }> = []
    createResilientSubscription(
      makeBinding({ version: { ofSnapshot: (s) => s.version, dense: true } }),
      {
        transport,
        policy: { ...TEST_POLICY, hydrationAbandonAfterFailures: 1 },
        random: () => 1,
        diagnostics: { onGap: (gap) => gaps.push(gap) },
      },
    )
    await flush()
    streams[0]?.pushEvent('progress', { percent: 60 }, { id: '6' })
    streams[0]?.pushEvent('progress', { percent: 80 }, { id: '8' })
    await flush()

    // The snapshot endpoint fails, so hydration is abandoned and the buffer is
    // flushed through the gate.
    snapshots[0]?.respond({ status: 'pending', version: 5 }, 500)
    await flush()

    expect(gaps).toEqual([{ from: 6, to: 8, reason: 'sequence' }])
    // No immediate repair poll: the snapshot endpoint is what just failed, and
    // the failure backoff already owns the next attempt.
    expect(snapshots).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(snapshots).toHaveLength(2)
  })
})

describe('createResilientSubscription — unorderable versions', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps delivering and reports the misconfiguration instead of wedging', async () => {
    const { transport, streams, snapshots } = makeHarness()
    const invalid: unknown[] = []
    const delivered: Array<FallbackEvent<Events>> = []
    const sub = createResilientSubscription(
      // A snapshot body whose version field is absent at runtime.
      makeBinding({ version: { ofSnapshot: () => undefined as unknown as number } }),
      {
        transport,
        policy: TEST_POLICY,
        random: () => 1,
        diagnostics: { onInvalidVersion: (info) => invalid.push(info) },
      },
    )
    sub.onEvent((event) => delivered.push(event))
    await flush()

    snapshots[0]?.respond({ status: 'pending', version: 1 })
    await flush()
    expect(invalid).toEqual([{ source: 'snapshot', value: undefined }])

    // Not wedged: the stream keeps delivering, and so does the next poll.
    streams[0]?.pushEvent('progress', { percent: 10 }, { id: '1' })
    await flush()
    await vi.advanceTimersByTimeAsync(1_000)
    snapshots[1]?.respond({ status: 'completed', result: 'ok', version: 2 })
    await flush()

    expect(delivered).toEqual([
      { event: 'progress', data: { percent: 10 }, id: '1', origin: 'sse' },
      { event: 'done', data: { result: 'ok' }, origin: 'poll' },
    ])
    expect(sub.status).toBe('stopped')
  })
})

describe('createResilientSubscription — abandoned hydration status', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not report a silent stream as live', async () => {
    const { transport, streams, snapshots } = makeHarness()
    const sub = createResilientSubscription(makeBinding(), {
      transport,
      policy: { ...TEST_POLICY, hydrationAbandonAfterFailures: 2 },
      random: () => 1,
    })
    await flush()
    expect(streams).toHaveLength(1)

    // The stream is accepted but produces nothing, and hydration polls fail.
    snapshots[0]?.fail()
    await vi.advanceTimersByTimeAsync(200)
    snapshots[1]?.fail()
    await vi.advanceTimersByTimeAsync(200)

    expect(sub.status).toBe('connecting')

    // The first real bytes are what earn 'live'.
    streams[0]?.pushHeartbeat()
    await flush()
    expect(sub.status).toBe('live')
  })
})

describe('createResilientSubscription — shared poll gate', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('caps reconciliation polls across subscriptions after a fleet-wide reconnect', async () => {
    const { transport, snapshots } = makeHarness()
    const gate = createPollGate({ maxConcurrent: 1 })
    const subs = [0, 1, 2].map(() =>
      createResilientSubscription(makeBinding(), {
        transport,
        policy: TEST_POLICY,
        random: () => 1,
        pollGate: gate,
      }),
    )
    await flush()

    // Without the gate all three hydration polls would be in flight at once.
    expect(snapshots).toHaveLength(1)

    snapshots[0]?.respond({ status: 'pending', version: 0 })
    await flush()
    expect(snapshots).toHaveLength(2)

    snapshots[1]?.respond({ status: 'pending', version: 0 })
    await flush()
    expect(snapshots).toHaveLength(3)

    for (const sub of subs) sub.stop()
  })

  it('releases the slot when a gated poll fails', async () => {
    const { transport, snapshots } = makeHarness()
    const gate = createPollGate({ maxConcurrent: 1 })
    const first = createResilientSubscription(makeBinding(), {
      transport,
      policy: TEST_POLICY,
      random: () => 1,
      pollGate: gate,
    })
    const second = createResilientSubscription(makeBinding(), {
      transport,
      policy: TEST_POLICY,
      random: () => 1,
      pollGate: gate,
    })
    await flush()

    snapshots[0]?.fail()
    await flush()

    expect(snapshots).toHaveLength(2)
    first.stop()
    second.stop()
  })

  it('does not hold a slot for a subscription that stops while queued', async () => {
    const { transport, snapshots } = makeHarness()
    const gate = createPollGate({ maxConcurrent: 1 })
    const holder = createResilientSubscription(makeBinding(), {
      transport,
      policy: TEST_POLICY,
      random: () => 1,
      pollGate: gate,
    })
    const queued = createResilientSubscription(makeBinding(), {
      transport,
      policy: TEST_POLICY,
      random: () => 1,
      pollGate: gate,
    })
    await flush()
    expect(snapshots).toHaveLength(1)

    queued.stop()
    snapshots[0]?.respond({ status: 'pending', version: 0 })
    await flush()

    // The stopped subscription never took the freed slot.
    expect(snapshots).toHaveLength(1)
    holder.stop()
  })
})
