/**
 * Server-Sent Events parsing, following the WHATWG event-stream interpreter.
 *
 * The wire format is frozen and both the server framework and the browser
 * client have to read it identically, so it lives in one dependency-free,
 * browser-safe package instead of a copy per consumer.
 *
 * {@link parseSSEBuffer} is the primitive: one pass over a buffer, returning
 * the events it completed and the bytes it could not. {@link parseSSEEvents}
 * is the whole-body convenience for a response already in memory. For streams,
 * prefer `createSSEStreamParser` / `parseSSEStream`, which own the buffer and
 * the reconnect cursor for you.
 *
 * @see https://html.spec.whatwg.org/multipage/server-sent-events.html
 */

/** A parsed SSE event. */
export type ParsedSSEEvent = {
  /** The `id:` field this event carried, when it carried one. */
  id?: string
  /** Event type name; servers may omit it (defaults to 'message'). */
  event?: string
  /** Event data payload as a string (multi-line data joined with newlines). */
  data: string
  /** Reconnection delay hint in milliseconds. */
  retry?: number
  /**
   * The Last-Event-ID cursor as of this event's dispatch.
   *
   * The spec keeps the last event ID across events, so an event with no `id:`
   * of its own still reconnects from the previous one, and an `id:` with an
   * empty value clears the cursor (this field is then absent). Kept apart from
   * {@link ParsedSSEEvent.id} because consumers order and deduplicate on the
   * id the event itself carried.
   */
  lastEventId?: string
}

/** Result of incremental SSE buffer parsing. */
export type ParseSSEBufferResult = {
  /** Complete events parsed from the buffer. */
  events: ParsedSSEEvent[]
  /** Remaining incomplete data to prepend to next chunk. */
  remaining: string
  /**
   * The Last-Event-ID cursor after every event the call consumed, including
   * id-only frames that dispatched no event. Feed it back into the next call
   * so the cursor survives across chunks.
   */
  lastEventId: string | undefined
  /**
   * The reconnection time in ms set by a `retry:` field this call read, or
   * `undefined` when it read none.
   *
   * The spec applies `retry:` as the field line is processed, not when a
   * frame dispatches, so a bare `retry: 30000` frame carrying no `data:`
   * still moves it, and reporting the hint only through the events that
   * happened to carry one would drop exactly that frame on the floor.
   * `undefined` means "no news": a hint established by an earlier call is the
   * caller's to hold. A hint in a frame the buffer has not terminated yet is
   * reported again by the call that finishes it.
   */
  retry: number | undefined
}

/** `retry:` carries ASCII digits only; any other value is ignored. */
const DIGITS_ONLY = /^\d+$/

/** U+FEFF, which the spec's decode step removes once at the start of a stream. */
const BYTE_ORDER_MARK = '﻿'

/**
 * Drop one leading BOM from the start of a stream.
 *
 * `TextDecoder` and `Response.text()` already do this, but a string built with
 * `Buffer.toString('utf8')` (what `fastify.inject()` hands back) does not, and
 * an unstripped BOM turns the first field name into `﻿data`, which the
 * interpreter ignores. That silently swallows the first event.
 *
 * Only valid at a stream boundary: mid-stream the same character is payload.
 */
export function stripStreamBOM(text: string): string {
  return text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text
}

/**
 * Split a field line into name and value per the spec: the value is everything
 * after the first colon minus at most ONE leading space, and a line with no
 * colon is a field name with an empty value.
 *
 * Trimming the value instead would corrupt payloads: `data:  two spaces  ` has
 * to keep one leading and both trailing spaces, which matters for any decoder
 * that reads the raw string rather than JSON.
 */
function splitField(line: string): { field: string; value: string } {
  const colon = line.indexOf(':')
  if (colon === -1) return { field: line, value: '' }
  const value = line.slice(colon + 1)
  return { field: line.slice(0, colon), value: value.startsWith(' ') ? value.slice(1) : value }
}

/**
 * Locate the end of the line starting at `from`.
 *
 * CR, LF and CRLF are all line terminators. A CR at the very end of the buffer
 * is left unconsumed: the next chunk decides whether it was a bare CR or the
 * first half of a CRLF, and consuming it early would split the terminator,
 * turning the LF that opens the next chunk into a spurious blank line that
 * dispatches mid-frame.
 */
function findLineEnd(buffer: string, from: number): { end: number; next: number } | undefined {
  for (let index = from; index < buffer.length; index += 1) {
    const char = buffer[index]
    if (char === '\n') return { end: index, next: index + 1 }
    if (char === '\r') {
      if (index === buffer.length - 1) return undefined
      return { end: index, next: buffer[index + 1] === '\n' ? index + 2 : index + 1 }
    }
  }
  return undefined
}

/** Parser state whose lifetime is the stream rather than one frame. */
type StreamFields = {
  /** The reconnection time set by the most recent valid `retry:`. */
  retry: number | undefined
}

/** The frame being assembled between two blank lines. */
type FrameState = {
  event: Partial<ParsedSSEEvent>
  dataLines: string[]
  /** Whether this frame carried an `id:` field, empty value included. */
  idSeen: boolean
}

/**
 * Apply one non-blank line to the frame under construction.
 *
 * `retry:` is the one field whose effect outlives its frame, so it lands in
 * `stream` rather than only on the event: the spec applies the reconnection
 * time as the line is read, dispatch or no dispatch.
 */
function applyFieldLine(line: string, state: FrameState, stream: StreamFields): void {
  // Comment lines (starting with :) are ignored; heartbeats arrive as one.
  if (line.startsWith(':')) return

  const { field, value } = splitField(line)
  if (field === 'id') {
    // A NUL in an id is the one value the spec drops on the floor.
    if (value.includes('\0')) return
    state.event.id = value
    state.idSeen = true
  } else if (field === 'event') {
    state.event.event = value
  } else if (field === 'data') {
    state.dataLines.push(value)
  } else if (field === 'retry' && DIGITS_ONLY.test(value)) {
    state.event.retry = Number(value)
    stream.retry = state.event.retry
  }
}

/**
 * Parse SSE events incrementally from a buffer.
 *
 * Designed for streaming: append each chunk to a buffer, call this, process
 * the returned events, and carry `remaining` and `lastEventId` into the next
 * iteration. {@link createSSEStreamParser} does that bookkeeping for you.
 *
 * A frame with no blank line after it stays in `remaining` and is never
 * dispatched. That is also the spec's rule for the end of a stream: pending
 * data is discarded, because a connection dropped mid-frame would otherwise
 * surface a truncated payload as if the server had sent it whole.
 *
 * Does not strip a leading BOM: that belongs to the stream entry points, which
 * know where the stream starts. See {@link stripStreamBOM}.
 *
 * @param buffer - buffered stream text, starting at an unconsumed line
 * @param lastEventId - the reconnect cursor the previous call returned
 */
export function parseSSEBuffer(buffer: string, lastEventId?: string): ParseSSEBufferResult {
  const events: ParsedSSEEvent[] = []
  const stream: StreamFields = { retry: undefined }
  let cursor = lastEventId
  let state: FrameState = { event: {}, dataLines: [], idSeen: false }
  let consumed = 0
  let position = 0

  while (position < buffer.length) {
    const lineEnd = findLineEnd(buffer, position)
    if (lineEnd === undefined) break
    const line = buffer.slice(position, lineEnd.end)
    position = lineEnd.next

    if (line !== '') {
      applyFieldLine(line, state, stream)
      continue
    }

    // A blank line dispatches, whether or not there is data to emit. The event
    // type and data buffers reset here, so an id-only frame can no longer leak
    // its id onto the next event, while the cursor it set deliberately
    // survives, which is what Last-Event-ID reconnects from.
    if (state.idSeen) cursor = state.event.id === '' ? undefined : state.event.id
    // Dispatch whenever the frame carried at least one `data:` field, which is
    // the spec's "data buffer is not empty" test. It runs BEFORE the trailing
    // newline is stripped, so `data:\n\n` is an event with an empty payload;
    // testing the joined string instead would swallow it.
    if (state.dataLines.length > 0) {
      events.push({
        ...state.event,
        data: state.dataLines.join('\n'),
        ...(cursor !== undefined ? { lastEventId: cursor } : {}),
      } as ParsedSSEEvent)
    }
    state = { event: {}, dataLines: [], idSeen: false }
    consumed = position
  }

  // Preserve any unconsumed content after the last dispatch, including a
  // partial event with only id:/event:/retry: lines.
  return { events, remaining: buffer.slice(consumed), lastEventId: cursor, retry: stream.retry }
}

/**
 * Parse every complete event out of a full SSE response body.
 *
 * For text that is already in memory in one piece: a `fastify.inject()` body,
 * a fixture, a `Response.text()`. A leading BOM is stripped, and a trailing
 * frame with no blank line after it is discarded the same way it would be at
 * the end of a live stream. Use {@link parseSSEBuffer} directly when you need
 * to inspect that leftover.
 *
 * @param text - complete SSE payload
 */
export function parseSSEEvents(text: string): ParsedSSEEvent[] {
  return parseSSEBuffer(stripStreamBOM(text)).events
}
