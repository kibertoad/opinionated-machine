/**
 * Transport seam: the core owns no HTTP. Implementations wrap fetch (browser,
 * via @lokalise/frontend-http-client), undici (Node), or scripted fixtures
 * (tests). Response-body validation (zod) belongs in the transport wrapper,
 * keeping this package dependency-free.
 */
import { parseSSEBuffer } from './sseParser.ts'

/** A channel-agnostic request description built from the binding + params. */
export type TransportRequest = {
  /** Resolved path (path params already substituted), no query string. */
  path: string
  /** Lowercase HTTP method from the contract. */
  method: string
  /** Query parameters, already stringified. */
  query?: Record<string, string>
  /** Extra request headers (auth etc. belongs in the transport itself). */
  headers?: Record<string, string>
  /** Request body for payload contracts. */
  body?: unknown
}

export type SnapshotResponse = {
  status: number
  headers: Record<string, string>
  /** Parsed response body (transport decides how; typically response.json()). */
  body: unknown
}

/**
 * The raw-chunk stream shape: the transport hands over decoded text and the
 * core does the SSE framing. This is the recommended variant — see
 * {@link StreamResponse}.
 */
export type RawStreamResponse = {
  status: number
  headers: Record<string, string>
  /**
   * Decoded text chunks as they arrive — INCLUDING comment/heartbeat frames.
   * The core parses SSE framing itself (vendored parser) and uses per-chunk
   * arrival as byte-level liveness. Iteration ends when the stream closes;
   * it throws on a mid-stream network error.
   */
  chunks: AsyncIterable<string>
}

/** One SSE frame, already framed by the transport. */
export type ParsedSseFrame = {
  /** The `id:` field, when the frame carried one. */
  id?: string
  /** The `event:` field; the core treats a missing name as `'message'`. */
  event?: string
  /** The raw `data:` payload, before `parseEventData`. */
  data: string
  /** The `retry:` reconnection hint in ms, when the frame carried one. */
  retry?: number
  /**
   * The Last-Event-ID cursor as of this frame, when the framing tracked it.
   *
   * The cursor persists across frames that carry no `id:` of their own and is
   * cleared by an empty `id:`, so it is not the same thing as {@link id}.
   * Transports wrapping a client that only exposes per-event ids leave it
   * unset; the core then falls back to {@link id}.
   */
  lastEventId?: string
}

/**
 * The parsed-event stream shape, for transports that cannot expose raw bytes.
 *
 * Wrapping an existing SSE client (`EventSource`, or an HTTP client whose SSE
 * mode yields events rather than text) is only possible in this shape, because
 * those clients drop comment frames before the caller ever sees them.
 *
 * The trade-off is liveness, not correctness: `staleConnectionTimeoutMs`
 * degrades from byte-level to EVENT-level, so a stream carrying nothing but
 * heartbeat comments looks idle and is force-closed after the timeout, and a
 * silently dead connection is only noticed once the timeout elapses. Heartbeat
 * *events* (a named event rather than a comment) still reset it. The deadman
 * poll is unaffected, so delivery stays correct either way.
 */
export type ParsedStreamResponse = {
  status: number
  headers: Record<string, string>
  /**
   * SSE frames as they arrive. Iteration ends when the stream closes; it
   * throws on a mid-stream network error.
   */
  events: AsyncIterable<ParsedSseFrame>
}

/**
 * What `openStream` resolves with. Prefer {@link RawStreamResponse}; use
 * {@link ParsedStreamResponse} when the underlying client will not give up its
 * raw bytes.
 */
export type StreamResponse = RawStreamResponse | ParsedStreamResponse

export type FallbackTransport = {
  /**
   * Fetch a snapshot (the JSON branch). Resolves with status/body even for
   * non-2xx responses; rejects only on network-level failure.
   *
   * Rate limiting across subscriptions is NOT handled here by default: after a
   * server blip every live subscription reconnects and fires its own
   * reconciliation poll at once. Either share a `pollGate` between
   * subscriptions (see `createPollGate`) or cap and stagger the requests
   * inside this method — one of the two is the transport author's
   * responsibility.
   */
  fetchSnapshot(request: TransportRequest, opts: { signal: AbortSignal }): Promise<SnapshotResponse>
  /**
   * Open the SSE branch. Resolves once response headers are received;
   * rejects only on network-level failure. A non-200 status (or a
   * non-`text/event-stream` content type) is a CONNECT FAILURE the core
   * counts toward degradation.
   */
  openStream(
    request: TransportRequest,
    opts: { signal: AbortSignal; lastEventId?: string },
  ): Promise<StreamResponse>
}

/** Whether a stream response hands over parsed frames instead of raw text. */
export function isParsedStreamResponse(response: StreamResponse): response is ParsedStreamResponse {
  return 'events' in response
}

// ============================================================================
// TestTransport — scripted transport for deterministic tests
// ============================================================================

type PendingChunk =
  | { kind: 'chunk'; text: string }
  | { kind: 'close' }
  | { kind: 'error'; error: Error }

type StreamController = {
  push(chunk: PendingChunk): void
  aborted: boolean
}

export type TestStreamHandle = {
  /** Emit a complete SSE event frame. */
  pushEvent(event: string, data: unknown, opts?: { id?: string; retry?: number }): void
  /** Emit a heartbeat comment frame (byte activity without a data event). */
  pushHeartbeat(): void
  /** Emit a raw text chunk verbatim. */
  pushRaw(text: string): void
  /** End the stream normally (server close). */
  close(): void
  /** Fail the stream mid-flight (network error). */
  fail(error?: Error): void
  readonly lastEventIdReceived: string | undefined
  readonly request: TransportRequest
}

export type TestSnapshotCall = {
  request: TransportRequest
  respond(body: unknown, status?: number): void
  fail(error?: Error): void
}

/**
 * Scripted {@link FallbackTransport} for unit tests. Pairs with fake timers:
 * snapshot calls and stream connects are surfaced through the `onSnapshot` /
 * `onStreamConnect` hooks (or the corresponding queues), and streams are
 * driven manually via {@link TestStreamHandle}.
 */
export class TestTransport implements FallbackTransport {
  /**
   * Which {@link StreamResponse} shape `openStream` resolves with. `'parsed'`
   * models a transport wrapping a client that only exposes framed events, so
   * pushed heartbeat comments never reach the core.
   */
  streamMode: 'raw' | 'parsed' = 'raw'
  /** Called for every snapshot fetch; respond synchronously or later. */
  onSnapshot?: (call: TestSnapshotCall) => void
  /** Called for every stream connect attempt after it is accepted. */
  onStreamConnect?: (stream: TestStreamHandle) => void
  /** Statuses (or an Error) to reject/deny the next N stream connects with. */
  private readonly connectDenials: Array<{ status?: number; error?: Error; hold?: true }> = []
  readonly snapshotCalls: TransportRequest[] = []
  readonly streamConnects: TransportRequest[] = []
  /** Whether each denied connect's request was aborted by the core. */
  readonly deniedConnectAborts: boolean[] = []

  /** Queue a denial for the next stream connect (non-200 status or network error). */
  denyNextStreamConnect(denial: { status?: number; error?: Error }): void {
    this.connectDenials.push(denial)
  }

  /**
   * Queue a stream connect that never produces response headers, settling only
   * when the core aborts it. Models an upstream that accepts the TCP
   * connection and then goes quiet.
   */
  holdNextStreamConnect(): void {
    this.connectDenials.push({ hold: true })
  }

  fetchSnapshot(
    request: TransportRequest,
    opts: { signal: AbortSignal },
  ): Promise<SnapshotResponse> {
    this.snapshotCalls.push(request)
    return new Promise<SnapshotResponse>((resolve, reject) => {
      if (opts.signal.aborted) {
        reject(new Error('aborted'))
        return
      }
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      const call: TestSnapshotCall = {
        request,
        respond: (body, status = 200) => resolve({ status, headers: {}, body }),
        fail: (error) => reject(error ?? new Error('snapshot network failure')),
      }
      if (this.onSnapshot) {
        this.onSnapshot(call)
      } else {
        reject(new Error('TestTransport.onSnapshot is not configured'))
      }
    })
  }

  openStream(
    request: TransportRequest,
    opts: { signal: AbortSignal; lastEventId?: string },
  ): Promise<StreamResponse> {
    this.streamConnects.push(request)

    const denial = this.connectDenials.shift()
    if (denial?.hold) {
      return new Promise<StreamResponse>((_resolve, reject) => {
        if (opts.signal.aborted) {
          reject(new Error('aborted'))
          return
        }
        opts.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }
    if (denial?.error) {
      return Promise.reject(denial.error)
    }
    if (denial?.status !== undefined) {
      const index = this.deniedConnectAborts.push(false) - 1
      opts.signal.addEventListener(
        'abort',
        () => {
          this.deniedConnectAborts[index] = true
        },
        { once: true },
      )
      return Promise.resolve({
        status: denial.status,
        headers: {},
        chunks: emptyChunks(),
      })
    }

    const queue: PendingChunk[] = []
    let notify: (() => void) | undefined
    const controller: StreamController = {
      aborted: false,
      push: (chunk) => {
        queue.push(chunk)
        notify?.()
      },
    }
    opts.signal.addEventListener(
      'abort',
      () => {
        controller.aborted = true
        notify?.()
      },
      { once: true },
    )

    const handle: TestStreamHandle = {
      pushEvent: (event, data, eventOpts) => {
        let frame = ''
        if (eventOpts?.id !== undefined) frame += `id: ${eventOpts.id}\n`
        frame += `event: ${event}\ndata: ${JSON.stringify(data)}\n`
        if (eventOpts?.retry !== undefined) frame += `retry: ${eventOpts.retry}\n`
        controller.push({ kind: 'chunk', text: `${frame}\n` })
      },
      pushHeartbeat: () => controller.push({ kind: 'chunk', text: ': heartbeat\n\n' }),
      pushRaw: (text) => controller.push({ kind: 'chunk', text }),
      close: () => controller.push({ kind: 'close' }),
      fail: (error) =>
        controller.push({ kind: 'error', error: error ?? new Error('stream network failure') }),
      lastEventIdReceived: opts.lastEventId,
      request,
    }

    const chunks = (async function* (): AsyncGenerator<string, void, unknown> {
      while (true) {
        if (controller.aborted) return
        const next = queue.shift()
        if (!next) {
          await new Promise<void>((resolve) => {
            notify = resolve
          })
          notify = undefined
          continue
        }
        if (next.kind === 'close') return
        if (next.kind === 'error') throw next.error
        yield next.text
      }
    })()

    this.onStreamConnect?.(handle)
    if (this.streamMode === 'parsed') {
      return Promise.resolve({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        events: framesOf(chunks),
      })
    }
    return Promise.resolve({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      chunks,
    })
  }
}

async function* emptyChunks(): AsyncGenerator<string, void, unknown> {
  // no chunks — used for denied connects
}

/**
 * Frame raw chunks the way a parsed-event client would: comment/heartbeat
 * frames are consumed by the framing and never surface as events.
 */
async function* framesOf(
  chunks: AsyncIterable<string>,
): AsyncGenerator<ParsedSseFrame, void, unknown> {
  let buffer = ''
  let cursor: string | undefined
  for await (const chunk of chunks) {
    buffer += chunk
    const parsed = parseSSEBuffer(buffer, cursor)
    buffer = parsed.remaining
    cursor = parsed.lastEventId
    for (const event of parsed.events) yield event
  }
}
