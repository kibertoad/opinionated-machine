import { describe, expect, it } from 'vitest'
import { parseSSEBuffer } from './sseParser.ts'

describe('parseSSEBuffer', () => {
  it('parses consecutive LF-framed events', () => {
    const { events, remaining } = parseSSEBuffer(
      'id: 1\nevent: tick\ndata: {"n":1}\n\nid: 2\nevent: tick\ndata: {"n":2}\n\n',
    )

    expect(events).toEqual([
      { id: '1', event: 'tick', data: '{"n":1}' },
      { id: '2', event: 'tick', data: '{"n":2}' },
    ])
    expect(remaining).toBe('')
  })

  it('parses consecutive CRLF-framed events as separate events', () => {
    // A CRLF stream leaves a trailing \r on every line, including the blank
    // separator — without stripping it the two events merge into one carrying
    // the first id and both payloads concatenated.
    const { events, remaining } = parseSSEBuffer(
      'id: 1\r\nevent: tick\r\ndata: {"n":1}\r\n\r\nid: 2\r\nevent: tick\r\ndata: {"n":2}\r\n\r\n',
    )

    expect(events).toEqual([
      { id: '1', event: 'tick', data: '{"n":1}' },
      { id: '2', event: 'tick', data: '{"n":2}' },
    ])
    expect(remaining).toBe('')
  })

  it('ignores comment frames and keeps an incomplete trailing event buffered', () => {
    const { events, remaining } = parseSSEBuffer(': heartbeat\n\ndata: {"n":1}\n\nid: 2\ndata: {"n')

    expect(events).toEqual([{ data: '{"n":1}' }])
    expect(remaining).toBe('id: 2\ndata: {"n')
  })

  it('joins multi-line data payloads', () => {
    const { events } = parseSSEBuffer('data: line one\ndata: line two\n\n')

    expect(events).toEqual([{ data: 'line one\nline two' }])
  })
})
