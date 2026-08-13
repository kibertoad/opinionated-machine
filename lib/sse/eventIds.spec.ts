import { describe, expect, it } from 'vitest'
import { compareEventIds, createEventIdSequence } from './eventIds.ts'

describe('createEventIdSequence', () => {
  it('produces monotonically increasing ids within an epoch', () => {
    const seq = createEventIdSequence({ epoch: 'e1' })
    const first = seq.next()
    const second = seq.next()
    const third = seq.next()

    expect(first).toBe('e1-000000000001')
    expect(second).toBe('e1-000000000002')
    expect(third < first).toBe(false)
    // Lexicographic order matches numeric order thanks to zero padding
    expect([third, first, second].sort()).toEqual([first, second, third])
  })

  it('tracks the current id', () => {
    const seq = createEventIdSequence({ epoch: 'e1' })
    expect(seq.current).toBeUndefined()
    const id = seq.next()
    expect(seq.current).toBe(id)
  })

  it('supports a custom starting counter', () => {
    const seq = createEventIdSequence({ epoch: 'e1', start: 41 })
    expect(seq.next()).toBe('e1-000000000042')
  })

  it('defaults the epoch to a timestamp so restarts start a new epoch', () => {
    const seq = createEventIdSequence()
    expect(seq.next()).toMatch(/^\d+-\d{12}$/)
  })
})

describe('compareEventIds', () => {
  it('orders ids within the same epoch', () => {
    const seq = createEventIdSequence({ epoch: 'e1' })
    const first = seq.next()
    const second = seq.next()

    expect(compareEventIds(first, second)).toBe(-1)
    expect(compareEventIds(second, first)).toBe(1)
    expect(compareEventIds(first, first)).toBe(0)
  })

  it('returns undefined across epochs (client must resync via poll)', () => {
    expect(compareEventIds('e1-000000000005', 'e2-000000000001')).toBeUndefined()
  })

  it('returns undefined for ids not produced by a sequence (e.g. UUIDs)', () => {
    expect(compareEventIds('not-an-id', 'e1-000000000001')).toBeUndefined()
    expect(compareEventIds('e1-000000000001', 'plainstring')).toBeUndefined()
  })

  it('handles epochs that themselves contain dashes', () => {
    // The epoch is everything before the LAST dash
    expect(compareEventIds('node-a-000000000001', 'node-a-000000000002')).toBe(-1)
    expect(compareEventIds('node-a-000000000001', 'node-b-000000000001')).toBeUndefined()
  })

  it('compares counters numerically beyond Number.MAX_SAFE_INTEGER padding', () => {
    expect(compareEventIds('e1-999999999998', 'e1-999999999999')).toBe(-1)
  })
})
