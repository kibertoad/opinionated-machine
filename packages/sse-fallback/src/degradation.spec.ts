import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FallbackBinding } from './binding.ts'
import type { FallbackBindingConfig, FallbackPolicy } from './bindingTypes.ts'
import {
  createResilientSubscription,
  FallbackDegradedError,
  FallbackHttpError,
} from './subscription.ts'
import { type TestSnapshotCall, type TestStreamHandle, TestTransport } from './transport.ts'

type Snap = { status: 'pending' | 'completed'; version: number }
type Events = { progress: { percent: number } }

const POLICY: Partial<FallbackPolicy> = {
  initialPoll: 'eager',
  deadmanDelayMs: 1_000,
  deadmanIdleBackoff: { factor: 1, maxMs: 1_000 },
  staleConnectionTimeoutMs: 5_000,
  pollFailureBackoff: { baseMs: 100, factor: 1, maxMs: 100 },
  sseRetryBackoff: { baseMs: 100, factor: 1, maxMs: 100 },
  degradedAfterFailures: 2,
  degradedPollIntervalMs: 2_000,
  degradedSseRetryMaxMs: 100,
  degradationReportIntervalMs: 10_000,
}

function makeBinding(
  overrides?: Partial<FallbackBindingConfig<Snap, Events, undefined>>,
): FallbackBinding<Snap, Events, undefined> {
  return {
    config: {
      snapshotToEvents: () => [],
      snapshotSource: 'endpoint',
      version: { ofSnapshot: (s) => s.version },
      ...overrides,
    },
    buildSnapshotRequest: () => ({ path: '/jobs/7', method: 'get' }),
    buildStreamRequest: () => ({ path: '/jobs/7/events', method: 'get' }),
  }
}

function makeHarness() {
  const transport = new TestTransport()
  const streams: TestStreamHandle[] = []
  const snapshots: TestSnapshotCall[] = []
  transport.onStreamConnect = (stream) => streams.push(stream)
  transport.onSnapshot = (call) => snapshots.push(call)
  return { transport, streams, snapshots }
}

const flush = () => vi.advanceTimersByTimeAsync(0)

describe('createResilientSubscription: degradation reports', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports a refused stream as an error naming the route, and keeps reporting it', async () => {
    const { transport } = makeHarness()
    const reports: FallbackDegradedError[] = []
    transport.denyNextStreamConnect({ status: 404 })
    const sub = createResilientSubscription(makeBinding(), {
      transport,
      policy: POLICY,
      diagnostics: { onDegraded: (error) => reports.push(error) },
      random: () => 1,
    })
    await flush()

    expect(sub.streamAbandoned).toBe(true)
    expect(reports).toHaveLength(1)
    const [first] = reports
    expect(first).toBeInstanceOf(FallbackDegradedError)
    expect(first?.name).toBe('FallbackDegradedError')
    expect(first?.message).toBe(
      'SSE stream GET /jobs/7/events was refused with 404 (it was never live); updates arrive late, on the fallback poll',
    )
    expect(first).toMatchObject({
      kind: 'stream-refused',
      status: 404,
      streamWasLive: false,
      pollCarriesDelivery: true,
      reportCount: 1,
      degradedForMs: 0,
    })
    expect(first?.cause).toBeInstanceOf(FallbackHttpError)
    expect(first?.cause).toMatchObject({ channel: 'stream', status: 404 })

    // An abandoned stream never recovers, so the report never stops.
    await vi.advanceTimersByTimeAsync(20_000)
    expect(reports.map((report) => report.reportCount)).toEqual([1, 2, 3])
    expect(reports[2]?.degradedForMs).toBe(20_000)

    sub.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(reports).toHaveLength(3)
  })

  it('reports a stream rejected with a retryable status, and the recovery that ends it', async () => {
    const { transport, streams, snapshots } = makeHarness()
    const reports: FallbackDegradedError[] = []
    const recoveries: unknown[] = []
    transport.denyNextStreamConnect({ status: 502 })
    transport.denyNextStreamConnect({ status: 502 })
    const sub = createResilientSubscription(makeBinding(), {
      transport,
      policy: POLICY,
      diagnostics: {
        onDegraded: (error) => reports.push(error),
        onRecovered: (recovery) => recoveries.push(recovery),
      },
      random: () => 1,
    })
    await vi.advanceTimersByTimeAsync(150)

    expect(sub.status).toBe('polling')
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ kind: 'stream-rejected', status: 502 })
    expect(reports[0]?.message).toContain('was rejected with 502')

    await vi.advanceTimersByTimeAsync(5_000)
    // The first accepted connect hydrates, which holds the status until a snapshot lands.
    for (const call of snapshots) call.respond({ status: 'pending', version: 1 })
    streams[0]?.pushHeartbeat()
    await flush()

    expect(sub.status).toBe('live')
    // Degraded on the second refusal, at 100ms.
    expect(recoveries).toEqual([{ kind: 'stream-rejected', degradedForMs: 5_050 }])
    // Past the reminder that was armed for 10_100ms, heartbeats holding off the stale watchdog.
    for (let second = 0; second < 20; second += 1) {
      streams[0]?.pushHeartbeat()
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(reports).toHaveLength(1)
  })

  it('names the content-type when a 200 is not an event stream', async () => {
    const { transport } = makeHarness()
    const reports: FallbackDegradedError[] = []
    const streamErrors: unknown[] = []
    for (let i = 0; i < 2; i += 1) {
      transport.denyNextStreamConnect({
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }
    createResilientSubscription(makeBinding(), {
      transport,
      policy: POLICY,
      diagnostics: {
        onDegraded: (error) => reports.push(error),
        onStreamError: (error) => streamErrors.push(error),
      },
      random: () => 1,
    })
    await vi.advanceTimersByTimeAsync(150)

    expect(reports[0]?.message).toContain('answered 200 with content-type text/html; charset=utf-8')
    expect(streamErrors[0]).toBeInstanceOf(FallbackHttpError)
  })

  it('reports a stream that is accepted and closes without a byte', async () => {
    const { transport, streams } = makeHarness()
    const reports: FallbackDegradedError[] = []
    transport.onStreamConnect = (stream) => {
      streams.push(stream)
      if (streams.length <= 2) stream.close()
    }
    createResilientSubscription(makeBinding(), {
      transport,
      policy: POLICY,
      diagnostics: { onDegraded: (error) => reports.push(error) },
      random: () => 1,
    })
    await vi.advanceTimersByTimeAsync(150)

    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ kind: 'stream-silent', status: undefined })
  })

  it('reports an unreachable stream with the network error as its cause', async () => {
    const { transport } = makeHarness()
    const reports: FallbackDegradedError[] = []
    const networkError = new TypeError('Failed to fetch')
    transport.denyNextStreamConnect({ error: networkError })
    transport.denyNextStreamConnect({ error: networkError })
    createResilientSubscription(makeBinding(), {
      transport,
      policy: POLICY,
      diagnostics: { onDegraded: (error) => reports.push(error) },
      random: () => 1,
    })
    await vi.advanceTimersByTimeAsync(150)

    expect(reports[0]).toMatchObject({ kind: 'stream-unreachable' })
    expect(reports[0]?.cause).toBe(networkError)
  })

  it('says nothing covers a synthesized binding while its stream is down', async () => {
    const { transport } = makeHarness()
    const reports: FallbackDegradedError[] = []
    for (let i = 0; i < 2; i += 1) transport.denyNextStreamConnect({ status: 503 })
    createResilientSubscription(makeBinding({ snapshotSource: 'synthesized' }), {
      transport,
      policy: POLICY,
      diagnostics: { onDegraded: (error) => reports.push(error) },
      random: () => 1,
    })
    await vi.advanceTimersByTimeAsync(150)

    expect(reports[0]?.pollCarriesDelivery).toBe(false)
    expect(reports[0]?.message).toContain('no poll covers this binding')
  })

  it('reports a refusal that follows a reported degradation at once, as a new cause', async () => {
    const { transport } = makeHarness()
    const reports: FallbackDegradedError[] = []
    transport.denyNextStreamConnect({ status: 502 })
    transport.denyNextStreamConnect({ status: 502 })
    transport.denyNextStreamConnect({ status: 403 })
    createResilientSubscription(makeBinding(), {
      transport,
      policy: POLICY,
      diagnostics: { onDegraded: (error) => reports.push(error) },
      random: () => 1,
    })
    await vi.advanceTimersByTimeAsync(300)

    expect(reports.map((report) => [report.kind, report.status, report.reportCount])).toEqual([
      ['stream-rejected', 502, 1],
      ['stream-refused', 403, 2],
    ])
  })

  it('names the current cause in a reminder, not the one that degraded it', async () => {
    const { transport } = makeHarness()
    const reports: FallbackDegradedError[] = []
    transport.denyNextStreamConnect({ error: new TypeError('Failed to fetch') })
    transport.denyNextStreamConnect({ error: new TypeError('Failed to fetch') })
    for (let i = 0; i < 200; i += 1) transport.denyNextStreamConnect({ status: 502 })
    createResilientSubscription(makeBinding(), {
      transport,
      policy: POLICY,
      diagnostics: { onDegraded: (error) => reports.push(error) },
      random: () => 1,
    })
    await vi.advanceTimersByTimeAsync(10_500)

    expect(reports.map((report) => [report.kind, report.status, report.reportCount])).toEqual([
      ['stream-unreachable', undefined, 1],
      ['stream-rejected', 502, 2],
    ])
  })

  it('stays stopped when onRecovered stops the subscription', async () => {
    const { transport, streams, snapshots } = makeHarness()
    transport.denyNextStreamConnect({ status: 502 })
    transport.denyNextStreamConnect({ status: 502 })
    let established = 0
    const sub = createResilientSubscription(makeBinding(), {
      transport,
      policy: POLICY,
      diagnostics: { onRecovered: () => sub.stop() },
      random: () => 1,
    })
    sub.onStreamEstablished(() => {
      established += 1
    })
    await vi.advanceTimersByTimeAsync(5_000)
    for (const call of snapshots) call.respond({ status: 'pending', version: 1 })
    streams[0]?.pushHeartbeat()
    await flush()

    expect(sub.status).toBe('stopped')
    expect(established).toBe(0)
  })

  it('reports once when the reminder is off', async () => {
    const { transport } = makeHarness()
    const reports: FallbackDegradedError[] = []
    transport.denyNextStreamConnect({ status: 404 })
    createResilientSubscription(makeBinding(), {
      transport,
      policy: { ...POLICY, degradationReportIntervalMs: 'off' },
      diagnostics: { onDegraded: (error) => reports.push(error) },
      random: () => 1,
    })
    await vi.advanceTimersByTimeAsync(60_000)

    expect(reports).toHaveLength(1)
  })

  it('does not report a subscription that was never meant to stream', async () => {
    const { transport } = makeHarness()
    const reports: FallbackDegradedError[] = []
    const sub = createResilientSubscription(makeBinding(), {
      transport,
      policy: { ...POLICY, mode: 'poll-only' },
      diagnostics: { onDegraded: (error) => reports.push(error) },
      random: () => 1,
    })
    await vi.advanceTimersByTimeAsync(30_000)

    expect(sub.status).toBe('polling')
    expect(reports).toHaveLength(0)
  })
})

describe('createResilientSubscription: onStreamEstablished', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('stays quiet while a degraded push-only stream is accepted and closed on every retry', async () => {
    const { transport, streams } = makeHarness()
    const statuses: string[] = []
    let established = 0
    transport.onStreamConnect = (stream) => {
      streams.push(stream)
      if (streams.length <= 4) stream.close()
    }
    const sub = createResilientSubscription(makeBinding({ snapshotSource: 'synthesized' }), {
      transport,
      policy: POLICY,
      random: () => 1,
    })
    sub.onStatusChange((status) => statuses.push(status))
    sub.onStreamEstablished(() => {
      established += 1
    })
    await vi.advanceTimersByTimeAsync(500)

    // Each accepted connect reports 'live', which is why a consumer's repair
    // cannot hang off the status without repeating on every retry.
    expect(statuses.filter((status) => status === 'live').length).toBeGreaterThan(1)
    expect(established).toBe(0)

    streams[4]?.pushHeartbeat()
    await flush()
    expect(established).toBe(1)

    streams[4]?.pushEvent('progress', { percent: 1 })
    await flush()
    expect(established).toBe(1)
  })
})

describe('createResilientSubscription: versionless polls racing the stream', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  type Flag = { on: boolean }
  const versionless = (): FallbackBinding<Flag, { flag: Flag }, undefined> => ({
    config: { snapshotEvent: 'flag', snapshotSource: 'endpoint', version: 'none' },
    buildSnapshotRequest: () => ({ path: '/flag', method: 'get' }),
    buildStreamRequest: () => ({ path: '/flag/events', method: 'get' }),
  })

  async function liveSubscription() {
    const transport = new TestTransport()
    const streams: TestStreamHandle[] = []
    const snapshots: TestSnapshotCall[] = []
    transport.onStreamConnect = (stream) => streams.push(stream)
    transport.onSnapshot = (call) => snapshots.push(call)
    const delivered: Array<{ on: boolean; origin: string }> = []
    let stale = 0
    const sub = createResilientSubscription(versionless(), {
      transport,
      policy: POLICY,
      diagnostics: {
        onStaleSnapshot: () => {
          stale += 1
        },
      },
      random: () => 1,
    })
    sub.onEvent((event) => delivered.push({ on: event.data.on, origin: event.origin }))
    await flush()
    snapshots[0]?.respond({ on: true })
    streams[0]?.pushHeartbeat()
    await flush()
    delivered.length = 0
    return { sub, streams, snapshots, delivered, stale: () => stale }
  }

  it('asks again instead of delivering a poll the stream overtook', async () => {
    const { sub, streams, snapshots, delivered, stale } = await liveSubscription()

    sub.nudge()
    await flush()
    expect(snapshots).toHaveLength(2)
    streams[0]?.pushEvent('flag', { on: false })
    await flush()
    snapshots[1]?.respond({ on: true })
    await flush()

    expect(delivered).toEqual([{ on: false, origin: 'sse' }])
    expect(stale()).toBe(1)
    expect(snapshots).toHaveLength(3)

    snapshots[2]?.respond({ on: false })
    await flush()
    expect(delivered).toEqual([
      { on: false, origin: 'sse' },
      { on: false, origin: 'poll' },
    ])
  })

  it('delivers the poll after three overtaken in a row, so a busy stream cannot starve it', async () => {
    const { sub, streams, snapshots, delivered } = await liveSubscription()

    sub.nudge()
    await flush()
    for (let i = 1; i <= 4; i += 1) {
      streams[0]?.pushEvent('flag', { on: false })
      await flush()
      snapshots[i]?.respond({ on: true })
      await flush()
    }

    expect(snapshots).toHaveLength(5)
    expect(delivered.filter((event) => event.origin === 'poll')).toEqual([
      { on: true, origin: 'poll' },
    ])
  })
})
