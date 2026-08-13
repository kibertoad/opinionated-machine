---
"opinionated-machine": minor
---

Adapt SSE routes to @fastify/sse 0.6 route kinds and restore per-route heartbeats.

- SSE-only routes are now registered with kind `'only'` (lenient Accept gate): a missing `Accept` header or `*/*` streams (previously errored with `FST_ERR_SSE_LEGACY_MISUSE`), and clients that explicitly refuse `text/event-stream` get a clean 406 (previously a 500).
- Dual-mode routes are now registered with kind `'manual'`, making the framework's `determineMode()` the single Accept negotiator — `defaultMode: 'sse'` now works with ambiguous Accept headers (previously crashed).
- Route-level and registration-time `heartbeatInterval` settings are effective again via a framework-managed heartbeat timer (both were silent no-ops under @fastify/sse 0.6, which only supports a plugin-level interval). The option type widened to `number | false`; `false`/`0` disables heartbeats for the route even when the plugin-level heartbeat is on.
- `SSEHttpClient` gained an `onRawChunk` hook that observes raw stream chunks, including `: heartbeat` comment frames the SSE parser drops.
