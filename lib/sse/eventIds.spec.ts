import { describe, expect, it } from 'vitest'
import {
  compareEventIds,
  createEventIdSequence,
  formatEventId,
  MAX_EVENT_ID_COUNTER,
} from './eventIds.ts'

describe('createEventIdSequence', () => {
  it('produces monotonically increasing ids within an epoch', () => {
    const seq = createEventIdSequence({ epoch: '1' })
    const first = seq.next()
    const second = seq.next()
    const third = seq.next()

    expect(first).toBe('1-000000000001')
    expect(second).toBe('1-000000000002')
    expect(third < first).toBe(false)
    // Lexicographic order matches numeric order thanks to zero padding
    expect([third, first, second].sort()).toEqual([first, second, third])
  })

  it('tracks the current id', () => {
    const seq = createEventIdSequence({ epoch: '1' })
    expect(seq.current).toBeUndefined()
    const id = seq.next()
    expect(seq.current).toBe(id)
  })

  it('supports a custom starting counter', () => {
    const seq = createEventIdSequence({ epoch: '1', start: 41 })
    expect(seq.next()).toBe('1-000000000042')
  })

  it('defaults the epoch to a timestamp so restarts start a new epoch', () => {
    const seq = createEventIdSequence()
    expect(seq.next()).toMatch(/^\d+-\d{12}$/)
  })

  it.each([
    ['non-finite', Number.POSITIVE_INFINITY],
    ['NaN', Number.NaN],
    ['fractional', 1.5],
    ['negative', -1],
    ['at the width limit', MAX_EVENT_ID_COUNTER],
    ['beyond the width limit', MAX_EVENT_ID_COUNTER + 1],
  ])('rejects a %s start value', (_label, start) => {
    expect(() => createEventIdSequence({ epoch: '1', start })).toThrow(TypeError)
  })

  it('rejects an empty epoch, which would produce unparseable ids', () => {
    expect(() => createEventIdSequence({ epoch: '' })).toThrow(TypeError)
  })

  it.each([
    ['deploy-blue'],
    ['e1'],
    ['1.5'],
    ['node a'],
    ['-1'],
  ])('rejects the non-numeric epoch %j the client could not order', (epoch) => {
    // The client's default version extractor only recognizes
    // `<digits>-<digits>`; anything else silently loses dedup, gap detection
    // and stale-poll protection, so the generator refuses it here instead.
    expect(() => createEventIdSequence({ epoch })).toThrow(TypeError)
  })

  it('refuses to widen the counter past the padded width', () => {
    const seq = createEventIdSequence({ epoch: '1', start: MAX_EVENT_ID_COUNTER - 2 })

    expect(seq.next()).toBe('1-999999999998')
    expect(seq.next()).toBe('1-999999999999')
    expect(() => seq.next()).toThrow(RangeError)
  })
})

describe('compareEventIds', () => {
  it('orders ids within the same epoch', () => {
    const seq = createEventIdSequence({ epoch: '1' })
    const first = seq.next()
    const second = seq.next()

    expect(compareEventIds(first, second)).toBe(-1)
    expect(compareEventIds(second, first)).toBe(1)
    expect(compareEventIds(first, first)).toBe(0)
  })

  it('returns undefined across epochs (client must resync via poll)', () => {
    expect(compareEventIds('1-000000000005', '2-000000000001')).toBeUndefined()
  })

  it('returns undefined for ids not produced by a sequence (e.g. UUIDs)', () => {
    expect(compareEventIds('not-an-id', '1-000000000001')).toBeUndefined()
    expect(compareEventIds('1-000000000001', 'plainstring')).toBeUndefined()
  })

  it('returns undefined for a UUID that superficially looks like a sequence id', () => {
    // `550e8400-e29b-41d4-a716-446655440000` ends in digits after a dash. A
    // looser epoch pattern would read `446655440000` as its counter and order
    // unrelated events by it; the numeric epoch is what rules it out.
    expect(
      compareEventIds('550e8400-e29b-41d4-a716-446655440000', '1-000000000001'),
    ).toBeUndefined()
  })

  it('compares counters numerically beyond Number.MAX_SAFE_INTEGER padding', () => {
    expect(compareEventIds('1-999999999998', '1-999999999999')).toBe(-1)
  })
})

describe('formatEventId', () => {
  it('produces ids that compare against an in-process sequence of the same epoch', () => {
    expect(formatEventId('1', 2)).toBe('1-000000000002')
    expect(compareEventIds(formatEventId('1', 1), formatEventId('1', 2))).toBe(-1)
  })

  it('accepts a bigint counter', () => {
    expect(formatEventId('1', 42n)).toBe('1-000000000042')
  })

  it('rejects an empty epoch', () => {
    // '-000000000001' has no epoch to compare against, so compareEventIds()
    // could never order it. createEventIdSequence() refuses the same input.
    expect(() => formatEventId('', 1)).toThrow(TypeError)
  })

  it('rejects a non-numeric epoch, matching createEventIdSequence', () => {
    expect(() => formatEventId('deploy-blue', 1)).toThrow(TypeError)
  })

  it('rejects a counter outside the fixed id width', () => {
    expect(() => formatEventId('1', 0)).toThrow(RangeError)
    expect(() => formatEventId('1', MAX_EVENT_ID_COUNTER + 1)).toThrow(RangeError)
  })
})
