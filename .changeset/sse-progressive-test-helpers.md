---
"opinionated-machine": minor
---

Read SSE responses as they are written, and with the contract's typing, on both test paths.

- `injectApiSSE` now injects with Fastify's `payloadAsStream` and exposes `head` (status and headers, as soon as the handler calls `sse.start()`) and `stream(signal?)`, which yields the contract's typed, validated events as the handler writes them. Progressive delivery can be asserted without `app.listen()`, a base URL or manual connection cleanup. `closed`, `events()` and `bodyForStatus()` are unchanged.
- `connectApiSSE(baseUrl, contract, params, options?)` connects over real HTTP using the contract for method, path, query params, headers and body, and reads the stream as the same discriminated union `injectApiSSE().events()` returns. `SSEHttpClient` gained `apiEvents(contract, signal?)` and `collectApiEvents(contract, countOrPredicate, timeout?)` for connections that already exist.
- A payload that fails its SSE event schema no longer reaches the test as an event that is simply missing: routes built with `buildApiRoute` report the failed send — event name, Zod issues and payload — to the helper reading the stream. A failure that ended the stream early is thrown by `events()` / `stream()` / the `connectApiSSE` readers; one the route caught and streamed around is recorded instead, so a handler with a working fallback keeps passing. `injectApiSSE(...).sendFailures()` and `connectApiSSE(...).sendFailures()` expose every record, `handled` flag included. Test-only, keyed on a header that only the helpers produce and that is ignored unless it names a diagnostics scope open in the same process.
- `connectApiSSE`'s readers reject a response that is not an event stream with its status and body, instead of waiting out the collection timeout on a stream that was never going to arrive, and invoke a caller's `collectEvents` predicate exactly once per event.
