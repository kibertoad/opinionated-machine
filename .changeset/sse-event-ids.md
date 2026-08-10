---
"opinionated-machine": minor
---

Add monotonic event-id helpers for SSE streams: `createEventIdSequence()` produces lexicographically ordered ids (`"<epoch>-<zero-padded counter>"`) suitable for `Last-Event-ID` reconnection, client-side ordering, and the polling-fallback version gate; `compareEventIds()` orders ids within an epoch and returns `undefined` across epochs (a signal to resynchronize via a snapshot poll).
