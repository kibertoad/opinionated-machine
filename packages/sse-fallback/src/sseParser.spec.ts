import { describe, expect, it } from 'vitest'
import { parseSSEBuffer } from './sseParser.ts'

describe('parseSSEBuffer', () => {
  it('parses consecutive LF-framed events', () => {
    const { events, remaining } = parseSSEBuffer(
      'id: 1\nevent: tick\ndata: {"n":1}\n\nid: 2\nevent: tick\ndata: {"n":2}\n\n',
    )

    expect(events).toEqual([
      { id: '1', event: 'tick', data: '{"n":1}', lastEventId: '1' },
      { id: '2', event: 'tick', data: '{"n":2}', lastEventId: '2' },
    ])
    expect(remaining).toBe('')
  })

  it('parses consecutive CRLF-framed events as separate events', () => {
    // A CRLF stream leaves a trailing \r on every line, including the blank
    // separator — without handling it the two events merge into one carrying
    // the first id and both payloads concatenated.
    const { events, remaining } = parseSSEBuffer(
      'id: 1\r\nevent: tick\r\ndata: {"n":1}\r\n\r\nid: 2\r\nevent: tick\r\ndata: {"n":2}\r\n\r\n',
    )

    expect(events).toEqual([
      { id: '1', event: 'tick', data: '{"n":1}', lastEventId: '1' },
      { id: '2', event: 'tick', data: '{"n":2}', lastEventId: '2' },
    ])
    expect(remaining).toBe('')
  })

  it('treats a bare CR as a line terminator', () => {
    // CR alone is a valid terminator; splitting on LF only would read the
    // whole frame as one unterminated line and emit nothing. The trailing CR
    // stays unconsumed until the next chunk says whether it was a CRLF.
    const { events, remaining } = parseSSEBuffer('event: tick\rdata: {"n":1}\r\rid: 2\r')

    expect(events).toEqual([{ event: 'tick', data: '{"n":1}' }])
    expect(remaining).toBe('id: 2\r')
  })

  it('holds back a trailing CR that may be half of a CRLF', () => {
    const first = parseSSEBuffer('data: {"n":1}\r')
    expect(first.events).toEqual([])
    expect(first.remaining).toBe('data: {"n":1}\r')

    const second = parseSSEBuffer(`${first.remaining}\n\n`)
    expect(second.events).toEqual([{ data: '{"n":1}' }])
  })

  it('ignores comment frames and keeps an incomplete trailing event buffered', () => {
    const { events, remaining } = parseSSEBuffer(': heartbeat\n\ndata: {"n":1}\n\nid: 2\ndata: {"n')

    expect(events).toEqual([{ data: '{"n":1}' }])
    expect(remaining).toBe('id: 2\ndata: {"n')
  })

  it('strips exactly one leading space from a field value and nothing else', () => {
    // The spec removes at most one space after the colon and preserves the
    // rest, so a raw-string decoder sees the payload the server wrote.
    const { events } = parseSSEBuffer('data:  keep spaces  \n\ndata:no space\n\ndata\n\n')

    expect(events).toEqual([{ data: ' keep spaces  ' }, { data: 'no space' }, { data: '' }])
  })

  it('ignores a malformed retry value instead of parsing its numeric prefix', () => {
    const { events } = parseSSEBuffer('retry: 100x\ndata: a\n\nretry: 250\ndata: b\n\n')

    expect(events[0]?.retry).toBeUndefined()
    expect(events[1]?.retry).toBe(250)
  })

  it('carries the reconnect cursor across a frame that dispatches no event', () => {
    // `id: reset` with no data still moves Last-Event-ID, and must NOT leak
    // onto the next event's own id — that would make it look like a duplicate.
    const { events, lastEventId } = parseSSEBuffer('id: reset\n\ndata: {"n":1}\n\n')

    expect(events).toEqual([{ data: '{"n":1}', lastEventId: 'reset' }])
    expect(events[0]?.id).toBeUndefined()
    expect(lastEventId).toBe('reset')
  })

  it('clears the reconnect cursor on an empty id field', () => {
    const { events, lastEventId } = parseSSEBuffer('id\n\ndata: {"n":1}\n\n', 'previous')

    expect(lastEventId).toBeUndefined()
    expect(events[0]?.lastEventId).toBeUndefined()
  })

  it('keeps the seeded cursor on an event that carries no id of its own', () => {
    const { events, lastEventId } = parseSSEBuffer('data: {"n":1}\n\n', 'seed')

    expect(events).toEqual([{ data: '{"n":1}', lastEventId: 'seed' }])
    expect(lastEventId).toBe('seed')
  })
})
