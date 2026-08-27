---
"opinionated-machine": minor
---

Support non-GET requests in `SSEHttpClient.connect()` via new `method` and `body` connect options, so POST/PUT/PATCH SSE endpoints can be tested over real HTTP instead of only through `SSEInjectClient`. `method` is accepted in either case, matching the lowercase spelling used by route contracts. Bodies `fetch()` sends natively (strings, `URLSearchParams`, `FormData`, `Blob`, `ArrayBuffer`, typed arrays, `ReadableStream`) are passed through untouched, everything else is JSON-stringified, and `content-type: application/json` is only defaulted when it does not overwrite an encoding `fetch()` describes itself. The response body is now locked lazily, so `client.response.json()` still works for endpoints that answered with a regular HTTP response (e.g. an error raised before `sse.start()`), and a bodiless response is reported when events are consumed rather than from `connect()`.
