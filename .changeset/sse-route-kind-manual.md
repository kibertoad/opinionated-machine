---
"opinionated-machine": minor
---

Register SSE and dual-mode routes with an explicit `@fastify/sse` kind of `'manual'` instead of falling back to the plugin's `'legacy'` kind.

Previously `buildFastifyRoute` emitted `sse: true` (or an options object without `kind`), which resolves to `'legacy'` and applies a strict `Accept` gate: a client that did not send an explicit `text/event-stream` token — a wildcard `Accept` header, `Accept: application/json`, or no `Accept` header at all — reached the SSE handler with `reply.sse` undefined, so the first `sse.start()` threw and the request returned a 500. The same applied to dual-mode routes configured with `defaultMode: 'sse'`. With `'manual'` there is no plugin-side negotiation: `reply.sse` is always attached and the handler decides whether to stream, which is what these route handlers already do.

Adds a `kind` route option so the default can be overridden, restricted per route type to the kinds that can actually work:

- SSE-only routes accept `'manual' | 'only'` (`SSEOnlyRouteKind`). `'only'` makes the plugin content-negotiate and answer `406 Not Acceptable` before the handler runs; note its gate admits a missing `Accept` header and the `*/*` and `text/*` wildcards but rejects every other concrete media type, `application/json` included.
- Dual-mode routes accept `'manual' | 'dual'` (`DualModeRouteKind`). Combining `kind: 'dual'` with `defaultMode: 'sse'` now throws at route-build time instead of returning a 500 per request, because the plugin's gate and the handler's own `determineMode()` disagree for wildcard or absent `Accept` headers.

Also stops the SSE teardown path from masking errors: `closeSSESession` re-read `reply.sse.isConnected` from inside its own `catch`, which raised a second `TypeError` and replaced the original failure, and `sse.start()` now marks the session started only after its first successful `reply.sse` access.
