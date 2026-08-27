---
"opinionated-machine": minor
---

Add `createSSESessionSpy()` testing factory so `buildApiRoute` routes can use `SSEHttpClient`'s `awaitServerConnection`. It returns a standalone `SSESessionSpy`, `{ onConnect, onClose }` route options to spread into a route with no lifecycle hooks of its own, and a `withSpy()` helper that merges the spy into a route's existing options by chaining rather than replacing its `onConnect` / `onClose`. `awaitServerConnection` now accepts `{ spy }` alongside `{ controller }`, and `SSESessionSpy` is generic over the observed session type, defaulting to the previous one.
