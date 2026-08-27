/**
 * SSE (Server-Sent Events) parsing utilities, per the W3C spec.
 *
 * Vendored from `opinionated-machine`'s `lib/sse/sseParser.ts` so this
 * package stays dependency-free and browser-safe. The wire format is a
 * frozen spec — behavioral divergence risk is negligible.
 *
 * @see https://html.spec.whatwg.org/multipage/server-sent-events.html
 */

/**
 * Parse a single SSE line and update the event state.
 * Returns true if a complete event was found (empty line with data).
 *
 * The caller splits on `\n` only, so a CRLF-framed stream leaves a trailing
 * `\r` on every line — including the blank line that terminates an event.
 * The spec allows CR, LF and CRLF as line terminators, so strip it here:
 * without that, consecutive events on a CRLF stream never terminate and merge
 * into one event with the wrong id and concatenated data.
 */
function parseSSELine(
  rawLine: string,
  currentEvent: Partial<ParsedSSEEvent>,
  dataLines: string[],
): boolean {
  const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
  if (line.startsWith('id:')) {
    currentEvent.id = line.slice(3).trim()
  } else if (line.startsWith('event:')) {
    currentEvent.event = line.slice(6).trim()
  } else if (line.startsWith('data:')) {
    dataLines.push(line.slice(5).trim())
  } else if (line.startsWith('retry:')) {
    currentEvent.retry = Number.parseInt(line.slice(6).trim(), 10)
  } else if (line === '' && dataLines.length > 0) {
    return true // Event complete
  }
  // Comment lines (starting with :) are implicitly ignored
  return false
}

/** A parsed SSE event. */
export type ParsedSSEEvent = {
  /** Event ID (feeds Last-Event-ID reconnection). */
  id?: string
  /** Event type name; servers may omit it (defaults to 'message'). */
  event?: string
  /** Event data payload as a string (multi-line data joined with newlines). */
  data: string
  /** Reconnection delay hint in milliseconds. */
  retry?: number
}

/** Result of incremental SSE buffer parsing. */
export type ParseSSEBufferResult = {
  /** Complete events parsed from the buffer */
  events: ParsedSSEEvent[]
  /** Remaining incomplete data to prepend to next chunk */
  remaining: string
}

/**
 * Parse SSE events incrementally from a buffer.
 *
 * Designed for streaming: append each chunk to a buffer, call this, process
 * the returned events, and carry `remaining` into the next iteration.
 */
export function parseSSEBuffer(buffer: string): ParseSSEBufferResult {
  const events: ParsedSSEEvent[] = []
  const lines = buffer.split('\n')

  let currentEvent: Partial<ParsedSSEEvent> = {}
  let dataLines: string[] = []
  let lastCompleteEventEnd = 0
  let currentPosition = 0

  for (const line of lines) {
    currentPosition += line.length + 1 // +1 for the \n

    if (parseSSELine(line, currentEvent, dataLines)) {
      events.push({
        ...currentEvent,
        data: dataLines.join('\n'),
      } as ParsedSSEEvent)
      currentEvent = {}
      dataLines = []
      lastCompleteEventEnd = currentPosition
    }
  }

  // Preserve any unconsumed content after the last complete event,
  // including incomplete events with only id:/event:/retry: lines
  const remaining = lastCompleteEventEnd < buffer.length ? buffer.slice(lastCompleteEventEnd) : ''
  return { events, remaining }
}
