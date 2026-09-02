---
"@opinionated-machine/sse-parser": minor
"@opinionated-machine/sse-fallback": minor
---

Close the fourth round of review findings on the SSE fallback stack.

**SSE parser**

- A `retry:` field is reported even when the frame carrying it dispatches nothing. `parseSSEBuffer` returns `retry` alongside `remaining` and the cursor, and `createSSEStreamParser` exposes it as a sticky `parser.retry`. The spec applies the reconnection time as the field line is read, so a server revising the delay with a bare `retry: 30000` frame was previously ignored: events are only emitted for frames with a `data:` field, and the hint rode along on the event or not at all.

**Fallback client (`@opinionated-machine/sse-fallback`)**

- Only an event the version gate actually delivered pushes the reconciliation poll out. The deadman was re-armed before the reconciler classified the frame, so a sustained flood of below-watermark duplicates suppressed the poll indefinitely while delivering nothing.
- A delivered event no longer resets the idle backoff to `deadmanDelayMs`. A stream delivering an event every 15s pinned the reconciliation poll at its base interval and polled between nearly every pair of events, forever, generating more traffic than a fully idle subscription, which backs off to `deadmanIdleBackoff.maxMs`. A healthily delivering stream needs less reconciliation, not more; only a poll that finds news the stream missed resets the interval.
- Completing subscribe-first hydration promotes the status to `'live'` only once the stream has produced bytes. It keyed off `streamConnected`, which is set when the response headers arrive, contradicting the rule the package applies everywhere else: headers are not delivery. A byte-less stream now stays `'connecting'` (or `'polling'` while degraded) until its first bytes arrive.
- A `retry:` hint on a frame with no `data:` moves the reconnect delay, via the parser's new stream-level hint.
