---
"opinionated-machine": minor
---

Add `createSSESessionSpy()` testing factory so `buildApiRoute` routes can use `SSEHttpClient`'s `awaitServerConnection`. It returns a standalone `SSESessionSpy` plus `{ onConnect, onClose }` route options to spread into the route, and `awaitServerConnection` now accepts `{ spy }` alongside `{ controller }`. `SSESessionSpy` is generic over the observed session type, defaulting to the previous one.
