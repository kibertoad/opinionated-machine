---
"opinionated-machine": minor
---

Register SSE and dual-mode routes with an explicit `@fastify/sse` kind of `'manual'` instead of falling back to the plugin's `'legacy'` kind.

Previously `buildFastifyRoute` emitted `sse: true` (or an options object without `kind`), which resolves to `'legacy'` and applies a strict `Accept` gate: a client that did not send an explicit `text/event-stream` token — a wildcard `Accept` header, `Accept: application/json`, or no `Accept` header at all — reached the SSE handler with `reply.sse` undefined, so the first `sse.start()` threw and the request returned a 500. The same applied to dual-mode routes configured with `defaultMode: 'sse'`. With `'manual'` there is no plugin-side negotiation: `reply.sse` is always attached and the handler decides whether to stream, which is what these route handlers already do.

Adds a `kind` route option (`'manual' | 'only' | 'dual'`) so the default can be overridden per route, e.g. `kind: 'only'` to return `406 Not Acceptable` to clients that explicitly refuse `text/event-stream`.
