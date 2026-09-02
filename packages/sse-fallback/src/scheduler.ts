import type { BackoffConfig } from './bindingTypes.ts'

/**
 * Timer + backoff helpers. Browser-safe: uses global setTimeout/clearTimeout
 * and calls Node's `unref` only when present.
 */

type TimerHandle = ReturnType<typeof setTimeout>

/** A single named resettable timer. */
export class ResettableTimer {
  private handle: TimerHandle | undefined
  private readonly onFire: () => void

  constructor(onFire: () => void) {
    this.onFire = onFire
  }

  /** (Re)arm the timer; a previously armed timeout is cancelled. */
  arm(delayMs: number): void {
    this.clear()
    this.handle = setTimeout(this.onFire, delayMs)
    // Don't keep a Node process alive for fallback timers (no-op in browsers).
    ;(this.handle as { unref?: () => void }).unref?.()
  }

  clear(): void {
    if (this.handle !== undefined) {
      clearTimeout(this.handle)
      this.handle = undefined
    }
  }

  get isArmed(): boolean {
    return this.handle !== undefined
  }
}

/**
 * Full-jitter exponential backoff: `random() * min(cap, base * factor^attempt)`.
 * Jitter prevents a thundering herd after a shared outage.
 */
export function backoffDelay(config: BackoffConfig, attempt: number, random: () => number): number {
  const ceiling = Math.min(config.maxMs, config.baseMs * config.factor ** attempt)
  return Math.max(0, Math.floor(random() * ceiling))
}

/** Sleep that resolves early (with `false`) when the signal aborts. */
export function sleep(delayMs: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false)
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    ;(timer as { unref?: () => void }).unref?.()
    const onAbort = () => {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
