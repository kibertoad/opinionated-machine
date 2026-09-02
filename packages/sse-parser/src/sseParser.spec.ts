import { describe, expect, it } from 'vitest'
import { parseSSEBuffer, parseSSEEvents } from './sseParser.ts'

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
    // separator. Without handling it the two events merge into one carrying
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

  it('dispatches a frame whose data field is empty', () => {
    // The spec tests the data buffer for emptiness BEFORE stripping the
    // trailing newline a `data:` field appends, so `data:` alone is an event
    // with an empty payload, not a frame to swallow. A parser that strips
    // first and tests after loses the event.
    const { events } = parseSSEBuffer('event: ping\ndata:\n\n')

    expect(events).toEqual([{ event: 'ping', data: '' }])
  })

  it('ignores a malformed retry value instead of parsing its numeric prefix', () => {
    const { events } = parseSSEBuffer('retry: 100x\ndata: a\n\nretry: 250\ndata: b\n\n')

    expect(events[0]?.retry).toBeUndefined()
    expect(events[1]?.retry).toBe(250)
  })

  it('reports a retry hint from a frame that dispatches no event', () => {
    // The spec sets the reconnection time when the field line is processed,
    // not when a frame dispatches, so a server revising the delay with a bare
    // `retry:` frame must be heard. Gating on dispatch drops it silently.
    const { events, retry } = parseSSEBuffer('retry: 30000\n\n')

    expect(events).toEqual([])
    expect(retry).toBe(30_000)
  })

  it('leaves the retry hint absent when the buffer carried none', () => {
    // Absent means "no news", so a caller holding a hint from an earlier
    // chunk keeps it instead of having it cleared by every quiet buffer.
    expect(parseSSEBuffer('data: a\n\n').retry).toBeUndefined()
    expect(parseSSEBuffer('retry: nope\n\n').retry).toBeUndefined()
  })

  it('reports the last retry hint in the buffer', () => {
    const { retry } = parseSSEBuffer('retry: 1000\ndata: a\n\nretry: 5000\n\n')

    expect(retry).toBe(5_000)
  })

  it('ignores an id field containing a NUL', () => {
    const { events, lastEventId } = parseSSEBuffer('id: bad\0id\ndata: a\n\n', 'seed')

    expect(events).toEqual([{ data: 'a', lastEventId: 'seed' }])
    expect(lastEventId).toBe('seed')
  })

  it('carries the reconnect cursor across a frame that dispatches no event', () => {
    // `id: reset` with no data still moves Last-Event-ID, and must NOT leak
    // onto the next event's own id, which would make it look like a duplicate.
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

  it('leaves a leading BOM alone', () => {
    // The primitive parses from an arbitrary offset, so it cannot know it is
    // looking at the start of a stream. Entry points that do know strip it.
    const { events, remaining } = parseSSEBuffer('﻿data: a\n\n')

    expect(events).toEqual([])
    expect(remaining).toBe('')
  })
})

describe('parseSSEEvents', () => {
  it('parses a complete response body', () => {
    const events = parseSSEEvents('event: a\ndata: 1\n\nevent: b\ndata: 2\n\n')

    expect(events).toEqual([
      { event: 'a', data: '1' },
      { event: 'b', data: '2' },
    ])
  })

  it('joins multi-line data with newlines', () => {
    const events = parseSSEEvents('event: log\ndata: line 1\ndata: line 2\n\n')

    expect(events).toEqual([{ event: 'log', data: 'line 1\nline 2' }])
  })

  it('strips a leading BOM', () => {
    // `Buffer.toString('utf8')`, which is what `fastify.inject()` hands back,
    // keeps the BOM that TextDecoder would have removed. Left in place it
    // turns the first field name into `﻿event` and the event vanishes.
    const events = parseSSEEvents('﻿event: a\ndata: 1\n\n')

    expect(events).toEqual([{ event: 'a', data: '1' }])
  })

  it('discards a trailing frame that no blank line terminated', () => {
    // A body cut mid-frame (an aborted response, a killed stream) must not
    // surface its truncated payload as a delivered event.
    const events = parseSSEEvents('data: {"n":1}\n\nid: 7\ndata: {"n')

    expect(events).toEqual([{ data: '{"n":1}' }])
  })
})
