import { sleep } from './scheduler.ts'

/**
 * Cross-subscription coordination for reconciliation polls.
 *
 * Each subscription jitters its own backoff, which spreads out ITS retries but
 * says nothing about the other subscriptions in the same tab. After a server
 * blip every live subscription reconnects at once and each fires its
 * post-reconnect reconciliation poll, so an app running dozens of
 * subscriptions turns one outage into a burst of dozens of simultaneous
 * requests against one origin.
 *
 * A gate is shared by every subscription that should be capped together
 * (normally one per origin). It bounds how many reconciliation polls run at
 * the same time and, with `staggerMs`, spreads the release of queued polls
 * over a window instead of letting them all start on the same tick.
 *
 * ```ts
 * const gate = createPollGate({ maxConcurrent: 4, staggerMs: 2_000 })
 * const sub = createResilientSubscription(binding, { transport, pollGate: gate })
 * ```
 *
 * A gate delays polls; it never cancels them. A subscription waiting for a
 * slot keeps its in-flight latch, so its deadman does not fire a second poll
 * behind the first.
 */
export type PollGate = {
  /**
   * Wait for permission to run a reconciliation poll. Resolves with a release
   * function that MUST be called when the poll settles.
   *
   * Rejects when `signal` aborts while waiting; nothing needs releasing then.
   */
  acquire(opts: { signal: AbortSignal }): Promise<() => void>
}

export type PollGateConfig = {
  /**
   * Maximum reconciliation polls in flight across every subscription sharing
   * this gate.
   * @default 6
   */
  maxConcurrent?: number
  /**
   * Spread window. Each poll waits a uniformly random delay in
   * `[0, staggerMs)` after taking a slot, so a fleet-wide reconnect does not
   * put every request on the same tick.
   * @default 0 (no stagger)
   */
  staggerMs?: number
  /** Injectable randomness for deterministic tests. */
  random?: () => number
}

/**
 * Create a {@link PollGate}: a shared concurrency cap plus an optional
 * randomized stagger for reconciliation polls.
 */
export function createPollGate(config?: PollGateConfig): PollGate {
  const maxConcurrent = Math.max(1, Math.floor(config?.maxConcurrent ?? 6))
  const staggerMs = Math.max(0, config?.staggerMs ?? 0)
  const random = config?.random ?? Math.random

  let active = 0
  const waiting: Array<() => void> = []

  const releaseSlot = (): void => {
    // Hand the slot straight to the next waiter rather than decrementing and
    // letting a fresh caller race in ahead of a subscription already queued.
    const next = waiting.shift()
    if (next) {
      next()
      return
    }
    active -= 1
  }

  const takeSlot = (signal: AbortSignal): Promise<void> => {
    if (active < maxConcurrent) {
      active += 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const grant = (): void => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }
      const onAbort = (): void => {
        const index = waiting.indexOf(grant)
        if (index >= 0) waiting.splice(index, 1)
        reject(new Error('Poll gate wait aborted'))
      }
      waiting.push(grant)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  return {
    async acquire(opts: { signal: AbortSignal }): Promise<() => void> {
      if (opts.signal.aborted) throw new Error('Poll gate wait aborted')
      await takeSlot(opts.signal)

      if (staggerMs > 0) {
        const proceeded = await sleep(Math.floor(random() * staggerMs), opts.signal)
        if (!proceeded) {
          releaseSlot()
          throw new Error('Poll gate wait aborted')
        }
      }

      let released = false
      return () => {
        if (released) return
        released = true
        releaseSlot()
      }
    },
  }
}
