import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPollGate } from './pollGate.ts'

const never = new AbortController().signal

describe('createPollGate', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('lets calls through up to the cap and queues the rest', async () => {
    const gate = createPollGate({ maxConcurrent: 2 })

    const first = await gate.acquire({ signal: never })
    await gate.acquire({ signal: never })

    let thirdGranted = false
    const third = gate.acquire({ signal: never }).then((release) => {
      thirdGranted = true
      return release
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(thirdGranted).toBe(false)

    first()
    await vi.advanceTimersByTimeAsync(0)
    expect(thirdGranted).toBe(true)
    await third
  })

  it('hands a freed slot to the queued caller rather than a fresh one', async () => {
    const gate = createPollGate({ maxConcurrent: 1 })
    const held = await gate.acquire({ signal: never })

    const order: string[] = []
    const queued = gate.acquire({ signal: never }).then(() => order.push('queued'))
    await vi.advanceTimersByTimeAsync(0)

    held()
    const latecomer = gate.acquire({ signal: never }).then(() => order.push('latecomer'))
    await vi.advanceTimersByTimeAsync(0)

    expect(order).toEqual(['queued'])
    await queued
    void latecomer
  })

  it('staggers granted polls across the configured window', async () => {
    let granted = false
    const gate = createPollGate({ maxConcurrent: 4, staggerMs: 1_000, random: () => 0.5 })

    void gate.acquire({ signal: never }).then(() => {
      granted = true
    })
    await vi.advanceTimersByTimeAsync(400)
    expect(granted).toBe(false)

    await vi.advanceTimersByTimeAsync(200)
    expect(granted).toBe(true)
  })

  it('spreads a fleet-wide reconnect instead of firing every poll on one tick', async () => {
    const randoms = [0.1, 0.35, 0.6, 0.85]
    let index = 0
    const gate = createPollGate({
      maxConcurrent: 4,
      staggerMs: 1_000,
      random: () => randoms[index++ % randoms.length] as number,
    })
    const grantedAt: number[] = []
    let now = 0

    for (let i = 0; i < 4; i++) {
      void gate.acquire({ signal: never }).then(() => grantedAt.push(now))
    }
    for (let step = 0; step < 4; step++) {
      now += 250
      await vi.advanceTimersByTimeAsync(250)
    }

    expect(grantedAt).toEqual([250, 500, 750, 1_000])
  })

  it('rejects a waiter whose subscription aborts, and frees nothing it never held', async () => {
    const gate = createPollGate({ maxConcurrent: 1 })
    const held = await gate.acquire({ signal: never })

    const controller = new AbortController()
    const waiting = gate.acquire({ signal: controller.signal })
    controller.abort()

    await expect(waiting).rejects.toThrow(/aborted/i)

    // The slot the aborted caller was waiting for is still the held one.
    held()
    await expect(gate.acquire({ signal: never })).resolves.toBeTypeOf('function')
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const gate = createPollGate()
    const controller = new AbortController()
    controller.abort()

    await expect(gate.acquire({ signal: controller.signal })).rejects.toThrow(/aborted/i)
  })

  it('ignores a double release, so one poll cannot free two slots', async () => {
    const gate = createPollGate({ maxConcurrent: 1 })
    const release = await gate.acquire({ signal: never })

    release()
    release()

    await gate.acquire({ signal: never })
    let extraGranted = false
    void gate.acquire({ signal: never }).then(() => {
      extraGranted = true
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(extraGranted).toBe(false)
  })
})
