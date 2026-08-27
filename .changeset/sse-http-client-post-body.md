---
"opinionated-machine": minor
---

Support non-GET requests in `SSEHttpClient.connect()` via new `method` and `body` connect options, so POST/PUT/PATCH SSE endpoints can be tested over real HTTP instead of only through `SSEInjectClient`. Object bodies are JSON-stringified with `content-type: application/json` defaulted; string bodies are sent verbatim. The response body is now locked lazily, so `client.response.json()` still works for endpoints that answered with a regular HTTP response (e.g. an error raised before `sse.start()`).
