/**
 * Stream-shaped entry points over {@link parseSSEBuffer}.
 *
 * Every consumer of the raw primitive ends up writing the same three lines:
 * concatenate the chunk onto a leftover buffer, parse, carry `remaining` and
 * the reconnect cursor into the next iteration. Getting that wrong is silent
 * (a dropped event, a stale `Last-Event-ID`), so it lives here once.
 */
import { type ParsedSSEEvent, parseSSEBuffer, stripStreamBOM } from './sseParser.ts'

export type SSEStreamParserOptions = {
  /**
   * Seed for the reconnect cursor, normally the `Last-Event-ID` the client
   * sent when reopening the stream. Events that carry no `id:` of their own
   * report this value as their `lastEventId`.
   */
  lastEventId?: string
}

/**
 * A stateful incremental parser: feed it decoded text, get complete events.
 *
 * One instance per connection. It owns the leftover buffer, the reconnect
 * cursor and the stream-start BOM, none of which survive a reconnect.
 */
export type SSEStreamParser = {
  /**
   * Parse everything the chunk completes.
   *
   * Returns a batch rather than one event at a time on purpose: the cursor
   * after a batch is the cursor after every frame in it, id-only frames that
   * dispatched nothing included, and a caller that gates delivery on the batch
   * needs to see them together.
   */
  push(chunk: string): ParsedSSEEvent[]
  /**
   * The reconnect cursor after everything pushed so far, including id-only
   * frames. This is what to send as `Last-Event-ID` when reconnecting.
   */
  readonly lastEventId: string | undefined
  /**
   * The reconnection time in ms the stream last asked for, once it has asked.
   *
   * Sticky and independent of dispatch, so a bare `retry: 30000` frame moves
   * it even though it delivers no event. Read it alongside each `push` when
   * the hint feeds a reconnect delay.
   */
  readonly retry: number | undefined
  /** Bytes of an unterminated frame held back for the next chunk. */
  readonly buffered: string
}

export function createSSEStreamParser(options: SSEStreamParserOptions = {}): SSEStreamParser {
  let buffer = ''
  let cursor = options.lastEventId
  let retry: number | undefined
  let atStreamStart = true

  return {
    push(chunk: string): ParsedSSEEvent[] {
      let text = chunk
      if (atStreamStart && text !== '') {
        text = stripStreamBOM(text)
        atStreamStart = false
      }
      buffer += text
      const parsed = parseSSEBuffer(buffer, cursor)
      buffer = parsed.remaining
      cursor = parsed.lastEventId
      if (parsed.retry !== undefined) retry = parsed.retry
      return parsed.events
    },
    get lastEventId(): string | undefined {
      return cursor
    },
    get retry(): number | undefined {
      return retry
    },
    get buffered(): string {
      return buffer
    },
  }
}

export type ParseSSEStreamOptions = SSEStreamParserOptions & {
  /**
   * Called with every chunk before it is parsed, comment frames included.
   *
   * Framing hides `: heartbeat` comments, so a consumer that watches only
   * parsed events cannot tell a silently dead connection from an idle one.
   * This hook is where byte-level liveness detection goes.
   */
  onChunk?: (chunk: string) => void
}

/**
 * Parse a stream of decoded text chunks into events.
 *
 * Iteration ends when the source ends; an unterminated trailing frame is
 * discarded, per the spec. Breaking out of the loop closes the source.
 */
export async function* parseSSEStream(
  chunks: AsyncIterable<string>,
  options: ParseSSEStreamOptions = {},
): AsyncGenerator<ParsedSSEEvent, void, unknown> {
  const parser = createSSEStreamParser(options)
  for await (const chunk of chunks) {
    options.onChunk?.(chunk)
    for (const event of parser.push(chunk)) yield event
  }
}

/** The part of `Response` this needs: a byte body, or none. */
export type SSEResponseLike = {
  body: ReadableStream<Uint8Array> | null
}

/**
 * Parse an SSE response body into events.
 *
 * The decode half of a `fetch`-based SSE client: reads the byte stream,
 * decodes UTF-8 across chunk boundaries (a multi-byte character split over two
 * network chunks stays one character), and frames it.
 *
 * ```ts
 * const response = await fetch(url, { headers: { accept: 'text/event-stream' } })
 * for await (const event of parseSSEResponse(response)) {
 *   handle(event.event ?? 'message', JSON.parse(event.data))
 * }
 * ```
 */
export async function* parseSSEResponse(
  response: SSEResponseLike,
  options: ParseSSEStreamOptions = {},
): AsyncGenerator<ParsedSSEEvent, void, unknown> {
  if (!response.body) throw new TypeError('Expected the response to have a body')
  yield* parseSSEStream(decodeTextChunks(response.body), options)
}

/** UTF-8 decode a byte stream into text chunks, holding split code points. */
async function* decodeTextChunks(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, unknown> {
  const decoder = new TextDecoder()
  const reader = body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) yield decoder.decode(value, { stream: true })
    }
    // Flush whatever the decoder was holding back mid-character.
    const tail = decoder.decode()
    if (tail !== '') yield tail
  } finally {
    // Cancelling releases the connection when the consumer stops early; on a
    // stream that already ended it resolves immediately.
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
