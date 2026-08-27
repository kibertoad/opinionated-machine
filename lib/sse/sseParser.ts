/**
 * SSE (Server-Sent Events) parsing utilities.
 *
 * This module provides utilities for parsing SSE event streams according
 * to the W3C Server-Sent Events specification.
 *
 * @see https://html.spec.whatwg.org/multipage/server-sent-events.html
 *
 * @module sseParser
 */

/**
 * A parsed SSE event.
 *
 * SSE events consist of optional id, event type, data, and retry fields.
 * The data field is always present and contains the event payload as a string.
 *
 * @example
 * ```typescript
 * const event: ParsedSSEEvent = {
 *   id: 'msg-123',
 *   event: 'message',
 *   data: '{"text":"Hello, world!"}',
 *   retry: 3000,
 * }
 *
 * // Parse the JSON data
 * const payload = JSON.parse(event.data)
 * ```
 */
/** `retry:` carries ASCII digits only; any other value is ignored. */
const DIGITS_ONLY = /^\d+$/

/**
 * Split a field line into name and value per the spec: the value is everything
 * after the first colon minus at most ONE leading space, and a line with no
 * colon is a field name with an empty value.
 *
 * Trimming the value instead would corrupt payloads — `data:  two spaces  `
 * has to keep one leading and both trailing spaces, which matters for any
 * consumer that reads the raw string rather than JSON.
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
 * One pass of the spec's event-stream interpreter over `buffer`.
 *
 * `consumed` is the offset just past the last dispatch, so an incremental
 * caller can re-feed everything after it with the next chunk. `lastEventId` is
 * the reconnect cursor: it persists across events that carry no `id:` of their
 * own, and an `id:` with an empty value clears it.
 */
function interpretStream(
  buffer: string,
  lastEventId: string | undefined,
): { events: ParsedSSEEvent[]; consumed: number; lastEventId: string | undefined } {
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

  return { events, consumed, lastEventId: cursor }
}

export type ParsedSSEEvent = {
  /**
   * Event ID for client reconnection via Last-Event-ID header.
   * When the client reconnects, it can send this ID to resume from where it left off.
   */
  id?: string
  /**
   * Event type name that maps to EventSource event listeners.
   * Defaults to 'message' when not specified.
   */
  event?: string
  /**
   * Event data payload as a string.
   * For multi-line data, lines are joined with newlines.
   * Typically contains JSON that should be parsed by the consumer.
   */
  data: string
  /**
   * Reconnection delay hint in milliseconds.
   * Suggests how long the client should wait before reconnecting.
   */
  retry?: number
  /**
   * The Last-Event-ID cursor as of this event's dispatch.
   *
   * The spec keeps the last event ID across events, so an event with no `id:`
   * of its own still reconnects from the previous one, and an `id:` with an
   * empty value clears the cursor (this field is then absent). Kept apart from
   * `id` because consumers order and deduplicate on the id the event itself
   * carried.
   */
  lastEventId?: string
}

/**
 * Parse SSE events from a complete text response.
 *
 * This function parses a complete SSE response body into individual events.
 * SSE events are separated by blank lines, and each event can have multiple fields.
 *
 * **SSE Format:**
 * ```
 * id: event-id
 * event: event-name
 * data: line1
 * data: line2
 * retry: 3000
 *
 * ```
 *
 * **Field Rules:**
 * - `id:` - Event ID for Last-Event-ID reconnection
 * - `event:` - Event type (defaults to 'message')
 * - `data:` - Event payload (multiple data lines are joined with newlines)
 * - `retry:` - Reconnection delay in milliseconds
 * - Lines starting with `:` are comments and ignored
 *
 * @param text - Raw SSE text to parse
 * @returns Array of parsed events
 *
 * @example
 * ```typescript
 * // Parse a simple SSE response
 * const text = `event: message
 * data: {"text":"hello"}
 *
 * event: done
 * data: {"status":"complete"}
 *
 * `
 * const events = parseSSEEvents(text)
 * // events = [
 * //   { event: 'message', data: '{"text":"hello"}' },
 * //   { event: 'done', data: '{"status":"complete"}' }
 * // ]
 * ```
 *
 * @example
 * ```typescript
 * // Parse events with IDs (for reconnection)
 * const text = `id: 1
 * event: update
 * data: {"value":42}
 *
 * id: 2
 * event: update
 * data: {"value":43}
 *
 * `
 * const events = parseSSEEvents(text)
 * // Store last ID for reconnection: events[events.length - 1].id
 * ```
 *
 * @example
 * ```typescript
 * // Multi-line data
 * const text = `event: log
 * data: Line 1
 * data: Line 2
 * data: Line 3
 *
 * `
 * const events = parseSSEEvents(text)
 * // events[0].data === "Line 1\nLine 2\nLine 3"
 * ```
 */
export function parseSSEEvents(text: string): ParsedSSEEvent[] {
  const { events, consumed, lastEventId } = interpretStream(text, undefined)

  // A response body that does not end with a blank line still carries a final
  // event; dispatch what is left of it here.
  const trailing = text.slice(consumed)
  if (trailing.length > 0) {
    const { events: tailEvents } = interpretStream(`${trailing}\n\n`, lastEventId)
    events.push(...tailEvents)
  }

  return events
}

/**
 * Result of incremental SSE buffer parsing.
 */
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

/**
 * Parse SSE events incrementally from a buffer.
 *
 * This function is designed for streaming scenarios where data arrives
 * in chunks. It parses complete events and returns any incomplete data
 * that should be prepended to the next chunk.
 *
 * **Usage Pattern:**
 * 1. Append new chunk to buffer
 * 2. Call parseSSEBuffer(buffer, lastEventId)
 * 3. Process the events
 * 4. Set buffer = remaining and lastEventId = result.lastEventId for the next
 *    iteration, so the reconnect cursor survives chunk boundaries
 *
 * @param buffer - Current buffer containing SSE data
 * @param lastEventId - The reconnect cursor the previous call returned
 * @returns Object with parsed events, remaining incomplete buffer, and cursor
 *
 * @example
 * ```typescript
 * // Streaming SSE parsing with fetch
 * const response = await fetch(url)
 * const reader = response.body.getReader()
 * const decoder = new TextDecoder()
 * let buffer = ''
 *
 * while (true) {
 *   const { done, value } = await reader.read()
 *   if (done) break
 *
 *   buffer += decoder.decode(value, { stream: true })
 *   const { events, remaining } = parseSSEBuffer(buffer)
 *   buffer = remaining
 *
 *   for (const event of events) {
 *     console.log('Received:', event.event, JSON.parse(event.data))
 *   }
 * }
 * ```
 *
 * @example
 * ```typescript
 * // Node.js readable stream
 * let buffer = ''
 * stream.on('data', (chunk: Buffer) => {
 *   buffer += chunk.toString()
 *   const { events, remaining } = parseSSEBuffer(buffer)
 *   buffer = remaining
 *
 *   events.forEach(event => emit('sse-event', event))
 * })
 * ```
 */
export function parseSSEBuffer(buffer: string, lastEventId?: string): ParseSSEBufferResult {
  const result = interpretStream(buffer, lastEventId)
  // Preserve any unconsumed content after the last dispatch, including a
  // partial event with only id:/event:/retry: lines.
  return {
    events: result.events,
    remaining: buffer.slice(result.consumed),
    lastEventId: result.lastEventId,
  }
}
