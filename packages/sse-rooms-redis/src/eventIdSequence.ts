import { type AsyncEventIdSequence, formatEventId } from 'opinionated-machine'

/**
 * Minimal interface for the counter half of a Redis-like client.
 *
 * `ioredis` satisfies this directly. `node-redis` names the command `incrBy`,
 * so wrap it: `{ incrby: (key, by) => client.incrBy(key, by) }`.
 */
export type RedisCounterClientLike = {
  /**
   * Atomically increment `key` by `increment` and return the new value.
   * Redis clients return a number; some return the reply as a string.
   */
  incrby(key: string, increment: number): Promise<number | string>
}

export type RedisEventIdSequenceConfig = {
  /** Redis client used for the counter. Any client, including the pub client. */
  client: RedisCounterClientLike

  /**
   * Redis key holding the counter. Use one key per ordering scope (per room,
   * per resource) — ids from different keys are not comparable.
   */
  key: string

  /**
   * Epoch label prefixed to every id.
   *
   * Defaults to `'0'`, a constant: the whole point of a Redis-backed counter is
   * that it survives restarts and is shared by every pod, so the epoch must NOT
   * vary per process. Override it only to deliberately force clients to
   * resynchronize (e.g. after deleting the counter key), and then use a larger
   * number than the previous one.
   *
   * Must be a string of digits — the client's default version extractor only
   * recognizes `<digits>-<digits>` ids as orderable.
   */
  epoch?: string
}

const DEFAULT_EPOCH = '0'

/**
 * Create an event-id sequence backed by Redis `INCR`.
 *
 * This is the multi-writer-safe counterpart of `createEventIdSequence()`: every
 * pod broadcasting into the same room shares one counter and one epoch, so ids
 * stay globally ordered and no writer's events are dropped as stale by the
 * client's version gate.
 *
 * ```ts
 * const seq = createRedisEventIdSequence({ client: redis, key: 'sse:seq:job:42' })
 * await broadcaster.broadcastToRoom(room, statusEvent, data, { id: await seq.next() })
 * ```
 *
 * One round trip per id, deliberately: reserving ids in blocks would let a pod
 * holding an earlier block publish after a pod holding a later one, which is
 * exactly the out-of-order delivery this exists to prevent.
 *
 * The counter orders ALLOCATION, not delivery. A writer can be descheduled
 * between `next()` and its broadcast while another pod allocates the next id
 * and publishes first; the client's version gate then drops the lower id as
 * stale. That is harmless for replacement-safe events (the payload describes
 * the state of the scope, or the id is a domain version written in the same
 * transaction) and is a real loss for delta events fed to a client-side
 * `state.apply`. For those, serialize allocation and publication per ordering
 * scope: one writer per scope, or a per-scope lock or outbox that publishes in
 * id order. Either way call `next()` immediately before the broadcast, with
 * nothing awaited in between — that gap is the window that reorders.
 *
 * When the resource already has a domain version (`job.version`, a revision
 * column), prefer that over any generated sequence — it is per-scope and
 * writer-independent for free, and the snapshot body has to carry it anyway.
 */
export function createRedisEventIdSequence(
  config: RedisEventIdSequenceConfig,
): AsyncEventIdSequence {
  const epoch = config.epoch ?? DEFAULT_EPOCH
  if (!/^\d+$/.test(epoch)) {
    throw new TypeError(
      `createRedisEventIdSequence: \`epoch\` must be a non-empty string of digits, got "${epoch}"`,
    )
  }
  if (config.key.length === 0) {
    throw new TypeError('createRedisEventIdSequence: `key` must be a non-empty string')
  }

  let current: string | undefined

  return {
    async next(): Promise<string> {
      const reply = await config.client.incrby(config.key, 1)
      const counter = typeof reply === 'string' ? Number(reply) : reply
      if (!Number.isInteger(counter)) {
        throw new TypeError(
          `createRedisEventIdSequence: INCRBY on "${config.key}" returned a non-integer reply: ${String(reply)}`,
        )
      }
      const id = formatEventId(epoch, counter)
      current = id
      return id
    },
    get current(): string | undefined {
      return current
    },
  }
}
