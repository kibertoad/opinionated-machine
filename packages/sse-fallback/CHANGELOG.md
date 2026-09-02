# @opinionated-machine/sse-fallback

## 0.1.0

### Minor Changes

- f0999ee: Initial release: browser-safe client core for SSE with a transparent polling fallback, built on `@opinionated-machine/sse-parser` and nothing else.
  
  - `defineFallbackBinding(contract, config)` declares the reconciliation (snapshot→events mapping, version extraction, terminal events, optional state reducer) on a dual-mode contract; `bindFallbackContracts` binds two separate contracts; `fromLegacyDualModeContract` adapts legacy `buildSseContract` contracts.
  - `createResilientSubscription(binding, { transport, params })` runs the client state machine: SSE as the low-latency channel, deadman-gated polls as the correctness backbone, a version gate for exactly-once-per-version delivery across both channels, subscribe-first hydration, byte-level stale-connection detection, `Last-Event-ID` reconnects, and degradation to pure polling with background SSE recovery.
  - Transport-agnostic (`FallbackTransport` seam) with a scripted `TestTransport` for deterministic fake-timer tests.
- f0999ee: Bound fallback connects and polls, clamp `retry:` hints, and recover from hydration and parsing failures.
  
  - **Bounded connects and polls.** New `connectTimeoutMs` and `pollTimeoutMs` policy fields. A stream connect that never produced response headers used to leave the subscription with no poll, no deadman and no stale watchdog armed — silent forever; a snapshot poll that never settled held the in-flight latch and left the deadman unarmed, disabling the correctness backbone outright. Both now fail like any other error: backoff, retry, degrade.
  - **A connect only counts as successful once it carries bytes.** A stream that was accepted and then closed immediately left the failure counter at zero, so backoff never grew and degradation never engaged — a reconnect-and-poll storm against a broken upstream. Status no longer reads `'live'` for a stream that has proven nothing.
  - **`retry:` hints are clamped** to the new `serverRetryHintBounds` instead of being used verbatim: `retry: 0` spun a zero-delay reconnect loop and a large value parked reconnection indefinitely.
  - **Hydration can be abandoned.** After `hydrationAbandonAfterFailures` consecutive snapshot failures the buffered events are flushed and live delivery resumes; a snapshot endpoint that kept failing used to hold the hydration buffer open while a healthy stream delivered nothing. Buffered events no longer push out the hydration retry poll either.
  - **Event ids produced by `createEventIdSequence()` now carry a version.** The default extractor was `Number(id)` — `NaN` for the `"<epoch>-<counter>"` format the docs recommend — which silently disabled dedup, the stale-poll guard and gap detection. It now reads both bare integers and sequence ids, ordering by epoch then counter (so a restarted counter is not read as a flood of duplicates), and still declines ids in other shapes such as UUIDs.
  - **Payload decoding is pluggable** via `parseEventData` (default `JSON.parse`), for routes with a custom `serializer`. An undecodable frame now triggers a repair poll and leaves `lastEventId` alone — it used to advance past an event it never delivered, so `Last-Event-ID` replay skipped it for good.
  - **A refused stream connect is aborted**, releasing the response body instead of leaking a socket per retry.
  - **CRLF-framed streams parse correctly** in the client parser: the blank separator line kept a trailing `\r`, so consecutive events merged into one with the wrong id and concatenated data.
- f0999ee: Close the review findings on the SSE fallback stack: room authorization and revocation, bounded stream lifetimes, multi-writer event ids, and the client's give-up and re-auth paths.
  
  **Rooms (`opinionated-machine`)**
  
  - `sseRooms` accepts an options object (`{ broadcaster, authorizeJoin, maxSessionLifetimeMs }`) alongside the bare broadcaster. `authorizeJoin` declares the scope check once per route instead of trusting every handler body — a room name built from a path param was previously joined unchecked. `maxSessionLifetimeMs` closes the session after N ms, forcing a re-authorized reconnect.
  - `ApiSseConnectionRegistry` gained `evict(connectionId)`, `evictFromRoom(room, connectionId)` and `closeRoom(room)`. Authorization is checked when a stream opens and then goes stale, so revocation now has something to call: before this a revoked user kept receiving broadcasts until the tab closed.
  
  **Event ids (`opinionated-machine`, `@opinionated-machine/sse-rooms-redis`)**
  
  - `createEventIdSequence()` validates `start` (integer, in range, below the id width) and `epoch` (non-empty), and refuses to widen the counter past its zero padding. `start: 999_999_999_999` used to produce a 13-digit id that no longer sorted after its 12-digit predecessor.
  - New `createRedisEventIdSequence()` backs the counter with Redis `INCR` under one shared epoch. Per-process sequences are safe only for a single writer: two pods broadcasting into the same room use different epochs, and a client ordering by epoch first silently drops the older pod's events. The docs now state that hazard and recommend domain versions as the default id source. `@opinionated-machine/sse-rooms-redis` needs those exports, so its `opinionated-machine` peer range moves from `>=6.8.0` to `>=10.1.0` — a breaking change for anyone on an older framework version.
  - `formatEventId()` rejects an empty epoch, the way `createEventIdSequence()` already did: `'-000000000001'` is an id `compareEventIds()` cannot parse, so nothing downstream can order it.
  
  **Envoy (`@opinionated-machine/gateway-envoy`)**
  
  - Streaming routes emit a route-level `max_stream_duration`, default 30 minutes, configurable via `EnvoyOptions.maxStreamDuration` or per route with the new `timeouts.maxDuration`. With both the route timeout and the idle timeout disabled, a streaming route had an unbounded lifetime, so the authorization checked at connect never expired.
  - The dual-mode SSE branch honours `Accept` quality values: `text/event-stream;q=0` is a refusal and now takes the JSON branch, where `contains` alone matched it. A `defaultMode: 'sse'` route emits a second plain branch (`<id>__json_sse_refused`) for the same refusal, because there the stream is the catch-all and the JSON branch's `contains` exclusion cannot match a header that names the type only to refuse it.
  - The manifest carries `streamingDefaultMode`, and a route declaring `defaultMode: 'sse'` inverts the Envoy split so the stream is the catch-all. Previously a request with a missing or wildcard `Accept` header streamed on the server but got the JSON branch's request timeout at the gateway.
  
  **Fallback client (`@opinionated-machine/sse-fallback`)**
  
  - Stops carry a reason: `sub.result`, `sub.onStop()`, a second `onStatusChange` argument, and `SubscriptionStoppedError` from `waitFor`. `'stopped'` alone could not tell a completed job from an auth failure or a caller's own `stop()`.
  - `policy.subscriptionBudget` (`maxDurationMs` / `maxPolls`, unset by default) stops a subscription whose backend never leaves its pending state, with a `'budget-exhausted'` reason. Every individual wait was bounded; the subscription as a whole was not.
  - `onAuthChallenge` makes an auth refusal recoverable once: refresh credentials and the refused poll or connect runs again. A 401 in a SPA is usually an expired token, and killing the subscription contradicted recovering without a page reload.
  - `policy.mode: 'poll-only'` (and the `POLL_ONLY_POLICY` preset) never opens a stream, so a backend can adopt the binding, version gate and state machine before its SSE endpoint exists.
  - `openStream` may resolve with `events: AsyncIterable<ParsedSseFrame>` instead of raw `chunks`, so adapters can wrap `EventSource` or an HTTP client that only exposes framed events. `staleConnectionTimeoutMs` degrades to event-level liveness in that mode; correctness is unaffected.
  - New `createPollGate()` caps and staggers reconciliation polls across subscriptions sharing one origin. Per-subscription jitter did nothing about a fleet-wide reconnect firing every subscription's poll on the same tick.
  - A throwing event/state/status listener no longer aborts the delivery loop or surfaces as a transport failure; faults go to `diagnostics.onListenerError`.
  - A gap-suspended state layer is repaired by any snapshot, not only one whose version matches the watermark exactly. Live events kept advancing the watermark after a gap, so the repair snapshot arrived below it, `apply` stayed disabled and `getState()` froze at its pre-gap value forever. The suspension is now reported on the outcome and through `diagnostics.onStateSuspended` / `onStateRepaired`. Events delivered during the suspension that the repair snapshot predates are replayed onto it, so a repair at revision 4 no longer drops a revision 5 that was already delivered; if more arrive than the buffer holds, the suspension holds until a snapshot reaches the watermark rather than dropping them silently.
  - Snapshot-synthesized events stop at the terminal event, matching `handleEvent` and `finishHydration`.
  - Version comparison no longer coerces unsafe integer strings through `Number()`: `9007199254740992` and `9007199254740993` collapsed to the same double, so the second event was dropped as a duplicate.
  - Abandoned hydration no longer reports a byte-less stream as `'live'`; bytes are what promote the subscription.
- f0999ee: Close three ways the version gate could wedge a subscription silently.
  
  - An **epoch regression** now resyncs instead of dropping everything. The epoch is compared before the duplicate gate, so a version in a different epoch is a re-scoping (`reason: 'epoch-change'`), never an older version — in either direction. Moving a writer from `createEventIdSequence()` (epoch seeded from `Date.now()`) to `createRedisEventIdSequence()` (epoch `'0'`), which the docs recommend for multi-writer scopes, lowers the epoch: every event and every snapshot after the switch ranked at or below a watermark they could never reach and was dropped as a duplicate, forever. The new epoch becomes the ordering scope, the gap is reported, and the repair poll rebuilds delta state. A binding that declares `version.compare` owns ordering end to end, epochs included, so its verdict is never overridden.
  - A **version the gate cannot order** is no longer stored as the watermark. `version.ofSnapshot` returning `undefined` (a snapshot body missing its version field), `NaN`, `Infinity` or an empty string poisoned the watermark: `defaultCompareVersions` fell through to a lexicographic comparison against `'undefined'`, so every later event and snapshot compared as a duplicate and was dropped. The item is delivered and the watermark stays put — at-least-once instead of nothing — and the new `diagnostics.onInvalidVersion` hook reports the degradation, which was otherwise invisible. `version.ofEvent` returning `undefined` remains a documented "this event carries no version" answer and is not reported.
  - **Gaps detected while flushing the hydration buffer** are no longer swallowed. Buffered events pass through the same version gate as live ones, but `SnapshotOutcome` had no `gap` field, so a hole found during the flush fired neither `diagnostics.onGap` nor the immediate repair poll and waited for the deadman instead. `handleSnapshot` and `abandonHydration` now carry the gap out (with the state suspension it caused); the poll path schedules the repair, and the abandon path leaves it to the failure backoff already armed, since the snapshot endpoint is what just failed.
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
- f0999ee: Close the third round of review findings on the SSE fallback stack.
  
  **SSE parser**
  
  - Field values follow the spec: exactly one leading space is removed after the colon and the rest is preserved. `trim()` was corrupting `data:  keep spaces  `, which matters for any decoder that reads the raw string instead of JSON.
  - CR, LF and CRLF are all line terminators. A CR at the end of the buffer is held back until the next chunk says whether it was half of a CRLF.
  - `retry:` accepts ASCII digits only. `parseInt` was reading `100x` as 100.
  - A blank line dispatches even with no data, so `id: reset\n\n` moves the Last-Event-ID cursor instead of leaking its id onto the next event, and an empty `id:` clears the cursor. `parseSSEBuffer(buffer, lastEventId)` takes the cursor in and returns it, and each event reports the cursor as of its dispatch in `lastEventId`.
  
  **Event ids (`opinionated-machine`, `@opinionated-machine/sse-rooms-redis`)**
  
  - `createEventIdSequence()`, `formatEventId()` and `createRedisEventIdSequence()` require a numeric epoch. `epoch: 'deploy-blue'` produced `deploy-blue-000000000001`, which the client's default version extractor reads as versionless: the same id delivered twice was not a duplicate, so dedup, gap detection and stale-poll protection were silently off. Restricting the epoch is what makes `<digits>-<digits>` an unambiguous marker for a generated id, since a UUID matches `<anything>-<digits>` too.
  
  **Fallback client (`@opinionated-machine/sse-fallback`)**
  
  - An epoch change is reported as a gap with `reason: 'epoch-change'` instead of being swallowed, so the subscription polls and suspends delta state and repairs from a snapshot. Applying deltas across a writer restart was silent, and a busy stream kept the deadman moving so the repair never came. Gaps from a skipped counter carry `reason: 'sequence'`.
  - A poll and a reconnect refused by the same expired token share one in-flight `onAuthChallenge` refresh. The second refusal used to see the retry already spent and stop the subscription while the refresh was still running; only a refusal after the refresh completes counts as the second failure now.
  
  **Rooms (`opinionated-machine`)**
  
  - A join whose async `authorizeJoin` verdict is still pending is cancelled by `leave`, `evictFromRoom`, `evict`, `closeRoom` and the session closing. The resolved verdict used to add the connection to a room it had just been removed from, so the revocation silently did not stick. `evictFromRoom` returns `true` when it cancels a pending join.
  
  **Envoy (`@opinionated-machine/gateway-envoy`)**
  
  - A dual-mode route emits a `<id>__negotiated` branch for an `Accept` header that names both `application/json` and `text/event-stream` as acceptable. The server ranks them by quality (and by header order on a tie), which RE2 header matchers cannot reproduce, so `application/json;q=0.9, text/event-stream;q=0.1` took the stream branch and ran the JSON poll with `timeout: 0s`. The stream branches are now narrowed to the cases the gateway can decide, and the negotiated branch carries bounds safe for either mode: no total-lifetime bound, plus an idle bound from `timeouts.idle` or `timeouts.request`. A route declaring `timeouts.request` warns that it cannot be enforced there.

### Patch Changes

- Updated dependencies [f0999ee]
- Updated dependencies [f0999ee]
  - @opinionated-machine/sse-parser@0.1.0
