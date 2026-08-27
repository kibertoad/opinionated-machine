import { compareEventIds } from 'opinionated-machine'
import { describe, expect, it } from 'vitest'
import { createRedisEventIdSequence, type RedisCounterClientLike } from './eventIdSequence.ts'

function fakeCounterClient(): RedisCounterClientLike & { values: Map<string, number> } {
  const values = new Map<string, number>()
  return {
    values,
    incrby(key: string, increment: number): Promise<number> {
      const next = (values.get(key) ?? 0) + increment
      values.set(key, next)
      return Promise.resolve(next)
    },
  }
}

describe('createRedisEventIdSequence', () => {
  it('produces ordered ids in the same format as the in-process sequence', async () => {
    const client = fakeCounterClient()
    const seq = createRedisEventIdSequence({ client, key: 'seq' })

    const first = await seq.next()
    const second = await seq.next()

    expect(first).toBe('0-000000000001')
    expect(second).toBe('0-000000000002')
    expect(compareEventIds(first, second)).toBe(-1)
  })

  it('keeps ids ordered across writers sharing one key', async () => {
    const client = fakeCounterClient()
    const podA = createRedisEventIdSequence({ client, key: 'seq' })
    const podB = createRedisEventIdSequence({ client, key: 'seq' })

    const ids = [await podA.next(), await podB.next(), await podA.next(), await podB.next()]

    expect(new Set(ids).size).toBe(4)
    for (let i = 1; i < ids.length; i++) {
      expect(compareEventIds(ids[i - 1] as string, ids[i] as string)).toBe(-1)
    }
  })

  it('tracks the current id', async () => {
    const client = fakeCounterClient()
    const seq = createRedisEventIdSequence({ client, key: 'seq' })

    expect(seq.current).toBeUndefined()
    const id = await seq.next()
    expect(seq.current).toBe(id)
  })

  it('accepts string replies from clients that return them', async () => {
    const seq = createRedisEventIdSequence({
      client: { incrby: () => Promise.resolve('7') },
      key: 'seq',
    })

    expect(await seq.next()).toBe('0-000000000007')
  })

  it('rejects a non-integer reply instead of emitting a broken id', async () => {
    const seq = createRedisEventIdSequence({
      client: { incrby: () => Promise.resolve('not-a-number') },
      key: 'seq',
    })

    await expect(seq.next()).rejects.toThrow(TypeError)
  })

  it.each([
    ['an empty key', { key: '' }],
    ['an empty epoch', { key: 'seq', epoch: '' }],
  ])('rejects %s', (_label, overrides) => {
    expect(() => createRedisEventIdSequence({ client: fakeCounterClient(), ...overrides })).toThrow(
      TypeError,
    )
  })

  it('isolates ordering scopes by key', async () => {
    const client = fakeCounterClient()
    const room = createRedisEventIdSequence({ client, key: 'seq:room' })
    const job = createRedisEventIdSequence({ client, key: 'seq:job' })

    expect(await room.next()).toBe('0-000000000001')
    expect(await job.next()).toBe('0-000000000001')
  })
})
