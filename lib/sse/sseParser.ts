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
/**
 * Parse a single SSE line and update the event state.
 * Returns true if a complete event was found (empty line with data).
 */
function parseSSELine(
  line: string,
  currentEvent: Partial<ParsedSSEEvent>,
  dataLines: string[],
): boolean {
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
  const events: ParsedSSEEvent[] = []
  const lines = text.split('\n')

  let currentEvent: Partial<ParsedSSEEvent> = {}
  let dataLines: string[] = []

  for (const line of lines) {
    if (parseSSELine(line, currentEvent, dataLines)) {
      events.push({
        ...currentEvent,
        data: dataLines.join('\n'),
      } as ParsedSSEEvent)
      currentEvent = {}
      dataLines = []
    }
  }

  // Handle case where stream doesn't end with double newline
  if (dataLines.length > 0) {
    events.push({
      ...currentEvent,
      data: dataLines.join('\n'),
    } as ParsedSSEEvent)
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
 * 2. Call parseSSEBuffer(buffer)
 * 3. Process the events
 * 4. Set buffer = remaining for next iteration
 *
 * @param buffer - Current buffer containing SSE data
 * @returns Object with parsed events and remaining incomplete buffer
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

  // Return remaining incomplete data
  // Preserve any unconsumed content after the last complete event,
  // including incomplete events with only id:/event:/retry: lines (not just data: lines)
  const remaining = lastCompleteEventEnd < buffer.length ? buffer.slice(lastCompleteEventEnd) : ''
  return { events, remaining }
}
