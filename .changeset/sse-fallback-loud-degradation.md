---
"@opinionated-machine/sse-fallback": minor
---

Report a broken stream instead of hiding it behind the fallback. A subscription that degrades hands a `FallbackDegradedError` to the new `diagnostics.onDegraded`, naming the route, the status and the channel left, and repeats it every `degradationReportIntervalMs` (default 10 minutes, `'off'` for once) until the stream carries bytes again, which `diagnostics.onRecovered` reports. Its `kind` separates a refused stream, a rejected one (a non-200, or a 200 that is not `text/event-stream`), one accepted and closed without a byte, and one that could not be reached. Non-200 answers now reach `onStreamError` / `onPollError` as a `FallbackHttpError` carrying `channel`, `status` and `request`.

Add `subscription.onStreamEstablished`, which fires when a connection carries its first byte. A synthesized binding reports `'live'` on the accepted connect, so repair work hung off `'live'` repeats on every retry against an upstream that accepts and closes at once.

With `version: 'none'`, a snapshot requested before the stream delivered an event is dropped and requested again rather than allowed to overwrite the newer pushed value, up to three times in a row.

`TestTransport.denyNextStreamConnect` accepts the response `headers`.
