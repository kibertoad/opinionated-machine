---
"opinionated-machine": minor
---

Expose raw SSE chunks on `SSEHttpClient` and fix CRLF framing in `parseSSEBuffer`.

- `SSEHttpClient` gained an `onRawChunk` hook that observes raw stream chunks as they arrive, including the `: heartbeat` comment frames the SSE parser drops. Useful for asserting heartbeat delivery and for byte-level liveness checks in tests.
- `parseSSEBuffer` handles CRLF-framed streams: the blank separator line kept a trailing `\r`, so consecutive events merged into one with the wrong id and concatenated data.
