---
"opinionated-machine": minor
---

`SSEHttpClient` gained an `onRawChunk` hook that observes raw stream chunks as they arrive, including the `: heartbeat` comment frames the SSE parser drops. Useful for asserting heartbeat delivery and for byte-level liveness checks in tests.
