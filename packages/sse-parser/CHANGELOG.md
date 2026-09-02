# @opinionated-machine/sse-parser

## 0.1.0

### Minor Changes

- f0999ee: Extract the SSE wire-format parser into `@opinionated-machine/sse-parser` and give it stream-shaped entry points.
  
  The parser existed twice: once in `opinionated-machine` for the server-side test helpers, once vendored into `@opinionated-machine/sse-fallback` for the browser client. The copies had already drifted in documentation and in what they exported, and every spec fix had to be applied to both. There is now one implementation, dependency-free and browser-safe, that both packages depend on.
  
  **New package `@opinionated-machine/sse-parser`**
  
  - `parseSSEBuffer(buffer, lastEventId?)` and `parseSSEEvents(text)`, unchanged apart from the spec fixes below.
  - `createSSEStreamParser({ lastEventId })` owns the partial-frame buffer, the reconnect cursor and the stream-start BOM across chunks. Every consumer was hand-rolling that bookkeeping, and `SSEHttpClient` was getting it wrong: it never fed the cursor back, so events carrying no `id:` of their own reported no `lastEventId`.
  - `parseSSEStream(chunks, { onChunk })` frames an async iterable of decoded text. `onChunk` sees every chunk before framing, comment frames included, which is what byte-level liveness detection needs: framed events alone cannot tell a heartbeat-only connection from a dead one.
  - `parseSSEResponse(response, options?)` reads a `fetch` response body: UTF-8 decoding across chunk boundaries, framing, and cancellation of the body when the consumer stops early.
  
  **Spec fixes**
  
  - A leading BOM is stripped at the start of a stream (`parseSSEEvents`, `createSSEStreamParser`, and therefore `parseSSEStream` and `parseSSEResponse`). `TextDecoder` and `Response.text()` already drop it, but `Buffer.toString('utf8')`, which is what `fastify.inject()` hands back, does not. An unstripped BOM turns the first field name into `﻿data`, which the interpreter ignores, silently swallowing the first event.
  - **Breaking:** `parseSSEEvents` no longer dispatches a trailing frame that no blank line terminated. The spec discards pending data at the end of a stream, and a body cut mid-frame (an aborted response, a killed stream, a progressive read) was surfacing its truncated payload as a delivered event. Call `parseSSEBuffer` directly when you need to inspect that leftover.
  
  **`opinionated-machine`**
  
  - Re-exports the whole parser surface, so `parseSSEBuffer` and `parseSSEEvents` keep working from the same import path, alongside the new stream helpers.
  - `SSEHttpClient` frames with `createSSEStreamParser`, which fixes the reconnect cursor it was dropping.
  
  **`@opinionated-machine/sse-fallback`**
  
  - Depends on the parser package instead of vendoring it, and re-exports it so a transport author does not need a second dependency to frame a stream. The one runtime dependency is first-party, dependency-free and browser-safe.
  - The subscription's chunk loop and the test transport's framing use the shared helpers.
- f0999ee: Close the fourth round of review findings on the SSE fallback stack.
  
  **SSE parser**
  
  - A `retry:` field is reported even when the frame carrying it dispatches nothing. `parseSSEBuffer` returns `retry` alongside `remaining` and the cursor, and `createSSEStreamParser` exposes it as a sticky `parser.retry`. The spec applies the reconnection time as the field line is read, so a server revising the delay with a bare `retry: 30000` frame was previously ignored: events are only emitted for frames with a `data:` field, and the hint rode along on the event or not at all.
  
  **Fallback client (`@opinionated-machine/sse-fallback`)**
  
  - Only an event the version gate actually delivered pushes the reconciliation poll out. The deadman was re-armed before the reconciler classified the frame, so a sustained flood of below-watermark duplicates suppressed the poll indefinitely while delivering nothing.
  - A delivered event no longer resets the idle backoff to `deadmanDelayMs`. A stream delivering an event every 15s pinned the reconciliation poll at its base interval and polled between nearly every pair of events, forever, generating more traffic than a fully idle subscription, which backs off to `deadmanIdleBackoff.maxMs`. A healthily delivering stream needs less reconciliation, not more; only a poll that finds news the stream missed resets the interval.
  - Completing subscribe-first hydration promotes the status to `'live'` only once the stream has produced bytes. It keyed off `streamConnected`, which is set when the response headers arrive, contradicting the rule the package applies everywhere else: headers are not delivery. A byte-less stream now stays `'connecting'` (or `'polling'` while degraded) until its first bytes arrive.
  - A `retry:` hint on a frame with no `data:` moves the reconnect delay, via the parser's new stream-level hint.
