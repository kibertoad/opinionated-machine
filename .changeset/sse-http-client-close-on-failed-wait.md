---
"opinionated-machine": patch
---

Fix `SSEHttpClient.connect()` leaking the open SSE response when `awaitServerConnection` times out. The caller never received a client handle, so a keep-alive stream stayed open and hung the test's `app.close()`, hiding the original timeout behind a suite-level timeout. A `waitForConnection` timeout now also explains itself when matching connections were registered but had already closed, which is what an `autoClose` session looks like to the spy.
