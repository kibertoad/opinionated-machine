import { describe, expect, it } from 'vitest'
import { createSSEStreamParser, parseSSEResponse, parseSSEStream } from './streamParser.ts'

async function* chunksOf(...chunks: string[]): AsyncGenerator<string, void, unknown> {
  // Awaited so the chunks arrive on separate ticks, the way a socket delivers
  // them, rather than synchronously draining into the parser.
  for (const chunk of chunks) yield await Promise.resolve(chunk)
}

function bodyOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

describe('createSSEStreamParser', () => {
  it('completes a frame split across chunks', () => {
    const parser = createSSEStreamParser()

    expect(parser.push('id: 1\ndata: {"n"')).toEqual([])
    expect(parser.buffered).toBe('id: 1\ndata: {"n"')
    expect(parser.push(':1}\n\n')).toEqual([{ id: '1', data: '{"n":1}', lastEventId: '1' }])
    expect(parser.buffered).toBe('')
    expect(parser.lastEventId).toBe('1')
  })

  it('keeps one event when a CRLF terminator lands on a chunk boundary', () => {
    // The chunk ends between the CR and the LF of a single terminator.
    // Consuming the CR as a line end would make the LF open a blank line,
    // splitting one two-line event into two and truncating its data.
    const parser = createSSEStreamParser()

    expect(parser.push('event: tick\r\ndata: a\r')).toEqual([])
    expect(parser.push('\ndata: b\r\n\r\n')).toEqual([{ event: 'tick', data: 'a\nb' }])
  })

  it('advances the cursor across an id-only frame that dispatches nothing', () => {
    const parser = createSSEStreamParser()

    expect(parser.push('data: a\n\nid: 99\n\n')).toEqual([{ data: 'a' }])
    expect(parser.lastEventId).toBe('99')
  })

  it('reports the seeded cursor on events that carry no id', () => {
    const parser = createSSEStreamParser({ lastEventId: 'seed' })

    expect(parser.push('data: a\n\n')).toEqual([{ data: 'a', lastEventId: 'seed' }])
  })

  it('strips a BOM at the start of the stream and nowhere else', () => {
    const parser = createSSEStreamParser()

    expect(parser.push('﻿data: a\n\n')).toEqual([{ data: 'a' }])
    // Mid-stream the same character is payload, not framing.
    expect(parser.push('data: ﻿b\n\n')).toEqual([{ data: '﻿b' }])
  })

  it('skips empty chunks when looking for the stream-start BOM', () => {
    // A decoder that swallowed a split multi-byte character can hand over an
    // empty first chunk; the BOM then arrives in the second one.
    const parser = createSSEStreamParser()

    expect(parser.push('')).toEqual([])
    expect(parser.push('﻿data: a\n\n')).toEqual([{ data: 'a' }])
  })
})

describe('parseSSEStream', () => {
  it('yields events across chunk boundaries', async () => {
    const events = []
    for await (const event of parseSSEStream(chunksOf('data: a\n\ndata:', ' b\n\n'))) {
      events.push(event)
    }

    expect(events).toEqual([{ data: 'a' }, { data: 'b' }])
  })

  it('reports every chunk to onChunk, comment frames included', async () => {
    const seen: string[] = []
    const events = []
    for await (const event of parseSSEStream(chunksOf(': heartbeat\n\n', 'data: a\n\n'), {
      onChunk: (chunk) => seen.push(chunk),
    })) {
      events.push(event)
    }

    // Framing drops the heartbeat, so the hook is the only evidence that the
    // connection is alive rather than silently dead.
    expect(seen).toEqual([': heartbeat\n\n', 'data: a\n\n'])
    expect(events).toEqual([{ data: 'a' }])
  })

  it('discards a trailing frame the stream ended in the middle of', async () => {
    const events = []
    for await (const event of parseSSEStream(chunksOf('data: a\n\nid: 7\ndata: {"n'))) {
      events.push(event)
    }

    expect(events).toEqual([{ data: 'a' }])
  })

  it('closes the source when the consumer stops early', async () => {
    let closed = false
    async function* infinite(): AsyncGenerator<string, void, unknown> {
      try {
        while (true) yield await Promise.resolve('data: a\n\n')
      } finally {
        closed = true
      }
    }

    for await (const event of parseSSEStream(infinite())) {
      expect(event.data).toBe('a')
      break
    }

    expect(closed).toBe(true)
  })
})

describe('parseSSEResponse', () => {
  const encoder = new TextEncoder()

  it('parses a byte body', async () => {
    const body = bodyOf(encoder.encode('event: tick\ndata: 1\n\n'))
    const events = []
    for await (const event of parseSSEResponse({ body })) events.push(event)

    expect(events).toEqual([{ event: 'tick', data: '1' }])
  })

  it('decodes a multi-byte character split across two byte chunks', async () => {
    const payload = encoder.encode('data: €\n\n')
    const body = bodyOf(payload.slice(0, 7), payload.slice(7))
    const events = []
    for await (const event of parseSSEResponse({ body })) events.push(event)

    expect(events).toEqual([{ data: '€' }])
  })

  it('rejects a response with no body', async () => {
    const iterator = parseSSEResponse({ body: null })

    await expect(iterator.next()).rejects.toThrow('Expected the response to have a body')
  })

  it('cancels the body when the consumer stops early', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(encoder.encode('data: a\n\n'))
      },
      cancel() {
        cancelled = true
      },
    })

    for await (const event of parseSSEResponse({ body })) {
      expect(event.data).toBe('a')
      break
    }

    expect(cancelled).toBe(true)
  })
})
