---
"opinionated-machine": minor
"@opinionated-machine/sse-fallback": minor
"@opinionated-machine/sse-rooms-redis": patch
"@opinionated-machine/gateway-envoy": minor
---

Close the third round of review findings on the SSE fallback stack.

**SSE parser (`opinionated-machine`, vendored in `@opinionated-machine/sse-fallback`)**

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
