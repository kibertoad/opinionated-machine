---
"opinionated-machine": minor
"@opinionated-machine/sse-fallback": minor
"@opinionated-machine/sse-rooms-redis": major
"@opinionated-machine/gateway-envoy": minor
---

Close the review findings on the SSE fallback stack: room authorization and revocation, bounded stream lifetimes, multi-writer event ids, and the client's give-up and re-auth paths.

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
