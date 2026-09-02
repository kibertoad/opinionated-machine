# @opinionated-machine/sse-rooms-redis

## 2.0.0

### Major Changes

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

### Patch Changes

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
