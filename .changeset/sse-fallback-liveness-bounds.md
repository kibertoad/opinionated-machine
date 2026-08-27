---
"@opinionated-machine/sse-fallback": minor
"opinionated-machine": patch
---

Close the gaps where the fallback subscription could stop being a fallback.

- **Bounded connects and polls.** New `connectTimeoutMs` and `pollTimeoutMs` policy fields. A stream connect that never produced response headers used to leave the subscription with no poll, no deadman and no stale watchdog armed — silent forever; a snapshot poll that never settled held the in-flight latch and left the deadman unarmed, disabling the correctness backbone outright. Both now fail like any other error: backoff, retry, degrade.
- **A connect only counts as successful once it carries bytes.** A stream that was accepted and then closed immediately left the failure counter at zero, so backoff never grew and degradation never engaged — a reconnect-and-poll storm against a broken upstream. Status no longer reads `'live'` for a stream that has proven nothing.
- **`retry:` hints are clamped** to the new `serverRetryHintBounds` instead of being used verbatim: `retry: 0` spun a zero-delay reconnect loop and a large value parked reconnection indefinitely.
- **Hydration can be abandoned.** After `hydrationAbandonAfterFailures` consecutive snapshot failures the buffered events are flushed and live delivery resumes; a snapshot endpoint that kept failing used to hold the hydration buffer open while a healthy stream delivered nothing. Buffered events no longer push out the hydration retry poll either.
- **Event ids produced by `createEventIdSequence()` now carry a version.** The default extractor was `Number(id)` — `NaN` for the `"<epoch>-<counter>"` format the docs recommend — which silently disabled dedup, the stale-poll guard and gap detection. It now reads both bare integers and sequence ids, ordering by epoch then counter (so a restarted counter is not read as a flood of duplicates), and still declines ids in other shapes such as UUIDs.
- **Payload decoding is pluggable** via `parseEventData` (default `JSON.parse`), for routes with a custom `serializer`. An undecodable frame now triggers a repair poll and leaves `lastEventId` alone — it used to advance past an event it never delivered, so `Last-Event-ID` replay skipped it for good.
- **A refused stream connect is aborted**, releasing the response body instead of leaking a socket per retry.
- **CRLF-framed streams parse correctly** in both the vendored client parser and the framework's own `parseSSEBuffer`: the blank separator line kept a trailing `\r`, so consecutive events merged into one with the wrong id and concatenated data.
