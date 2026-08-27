/**
 * SSE (Server-Sent Events) parsing utilities, per the W3C spec.
 *
 * Vendored from `opinionated-machine`'s `lib/sse/sseParser.ts` so this
 * package stays dependency-free and browser-safe. The wire format is a
 * frozen spec — behavioral divergence risk is negligible.
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
  /** Complete events parsed from the buffer */
  events: ParsedSSEEvent[]
  /** Remaining incomplete data to prepend to next chunk */
  remaining: string
  /**
   * The Last-Event-ID cursor after every event the call consumed, including
   * id-only frames that dispatched no event. Feed it back into the next call
   * so the cursor survives across chunks.
   */
  lastEventId: string | undefined
}

/** `retry:` carries ASCII digits only; any other value is ignored. */
const DIGITS_ONLY = /^\d+$/

/**
 * Split a field line into name and value per the spec: the value is everything
 * after the first colon minus at most ONE leading space, and a line with no
 * colon is a field name with an empty value.
 *
 * Trimming the value instead would corrupt payloads — `data:  two spaces  `
 * has to keep one leading and both trailing spaces, which matters for any
 * decoder that reads the raw string rather than JSON.
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
 * first half of a CRLF, and consuming it early would split the terminator.
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

/** The frame being assembled between two blank lines. */
type FrameState = {
  event: Partial<ParsedSSEEvent>
  dataLines: string[]
  /** Whether this frame carried an `id:` field, empty value included. */
  idSeen: boolean
}

/** Apply one non-blank line to the frame under construction. */
function applyFieldLine(line: string, state: FrameState): void {
  // Comment lines (starting with :) are ignored — heartbeats arrive as one.
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
  }
}

/**
 * Parse SSE events incrementally from a buffer.
 *
 * Designed for streaming: append each chunk to a buffer, call this, process
 * the returned events, and carry `remaining` and `lastEventId` into the next
 * iteration.
 *
 * @param buffer - buffered stream text, starting at an unconsumed line
 * @param lastEventId - the reconnect cursor the previous call returned
 */
export function parseSSEBuffer(buffer: string, lastEventId?: string): ParseSSEBufferResult {
  const events: ParsedSSEEvent[] = []
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
      applyFieldLine(line, state)
      continue
    }

    // A blank line dispatches, whether or not there is data to emit. The event
    // type and data buffers reset here, so an id-only frame can no longer leak
    // its id onto the next event, while the cursor it set deliberately
    // survives — that is what Last-Event-ID reconnects from.
    if (state.idSeen) cursor = state.event.id === '' ? undefined : state.event.id
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
  return { events, remaining: buffer.slice(consumed), lastEventId: cursor }
}
