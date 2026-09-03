# opinionated-machine

## 11.0.1

### Patch Changes

- be94a1f: Move the framework's sources from the workspace root into `packages/opinionated-machine`, so every
  package in the repo lives under `packages/*`.
  
  The published contents are unchanged: same entry points, same `files`, same README and CHANGELOG.
  `repository.directory` now points at the package, and the workspace root is private and holds only
  the orchestration scripts (`build:all`, `lint:all`, `test:all`, `changeset`, `ci:publish`) plus the
  shared `tsconfig.json`, `biome.jsonc` and `turbo.jsonc` every package extends.
  
  `@opinionated-machine/sse-fallback` is now a declared devDependency of the framework package rather
  than a relative path into a sibling directory, which is what lets turbo order and hash the suite
  that integrates against it.
- be94a1f: Orchestrate workspace tasks with Turborepo.
  
  `turbo.jsonc` declares each task's dependencies, inputs and outputs, so ordering follows the
  workspace graph instead of hand-written `pnpm --filter` chains. The per-package `build` scripts
  lost their `pnpm --filter @opinionated-machine/sse-parser run build` prefix and now compile
  exactly one package; `pnpm run build:all` and `pnpm run lint:all` drive the whole graph.
  
  Keeping the per-package `build` scripts single-package also keeps `prepublishOnly` safe: changesets
  publishes chunk-mates concurrently, so a hook that rebuilt sibling packages would `rimraf` a `dist`
  that another `pnpm publish` was packing at that moment.

## 11.0.0

### Major Changes

- f0999ee: Extract the SSE wire-format parser into `@opinionated-machine/sse-parser` and give it stream-shaped entry points.
  
  The parser existed twice: once in `opinionated-machine` for the server-side test helpers, once vendored into `@opinionated-machine/sse-fallback` for the browser client. The copies had already drifted in documentation and in what they exported, and every spec fix had to be applied to both. There is now one implementation, dependency-free and browser-safe, that both packages depend on.
  
  **New package `@opinionated-machine/sse-parser`**
  
  - `parseSSEBuffer(buffer, lastEventId?)` and `parseSSEEvents(text)`, unchanged apart from the spec fixes below.
  - `createSSEStreamParser({ lastEventId })` owns the partial-frame buffer, the reconnect cursor and the stream-start BOM across chunks. Every consumer was hand-rolling that bookkeeping, and `SSEHttpClient` was getting it wrong: it never fed the cursor back, so events carrying no `id:` of their own reported no `lastEventId`.
  - `parseSSEStream(chunks, { onChunk })` frames an async iterable of decoded text. `onChunk` sees every chunk before framing, comment frames included, which is what byte-level liveness detection needs: framed events alone cannot tell a heartbeat-only connection from a dead one.
  - `parseSSEResponse(response, options?)` reads a `fetch` response body: UTF-8 decoding across chunk boundaries, framing, and cancellation of the body when the consumer stops early.
  
  **Spec fixes**
  
  - A leading BOM is stripped at the start of a stream (`parseSSEEvents`, `createSSEStreamParser`, and therefore `parseSSEStream` and `parseSSEResponse`). `TextDecoder` and `Response.text()` already drop it, but `Buffer.toString('utf8')`, which is what `fastify.inject()` hands back, does not. An unstripped BOM turns the first field name into `﻿data`, which the interpreter ignores, silently swallowing the first event.
  - **Breaking:** `parseSSEEvents` no longer dispatches a trailing frame that no blank line terminated. The spec discards pending data at the end of a stream, and a body cut mid-frame (an aborted response, a killed stream, a progressive read) was surfacing its truncated payload as a delivered event. Call `parseSSEBuffer` directly when you need to inspect that leftover.
  
  **`opinionated-machine`**
  
  - Re-exports the whole parser surface, so `parseSSEBuffer` and `parseSSEEvents` keep working from the same import path, alongside the new stream helpers.
  - `SSEHttpClient` frames with `createSSEStreamParser`, which fixes the reconnect cursor it was dropping.
  
  **`@opinionated-machine/sse-fallback`**
  
  - Depends on the parser package instead of vendoring it, and re-exports it so a transport author does not need a second dependency to frame a stream. The one runtime dependency is first-party, dependency-free and browser-safe.
  - The subscription's chunk loop and the test transport's framing use the shared helpers.

### Minor Changes

- f0999ee: Add SSE rooms support to the modern api-contracts path.
  
  `buildApiRoute` accepts a new `sseRooms: SSERoomBroadcaster` option: sessions opened by the route's SSE handler are registered with the broadcaster (so `broadcastToRoom`/`broadcastMessage` reach them), get room operations via the new `getSessionRooms(session)` accessor, and are cleaned up (rooms left, dedup cache cleared) when the connection closes. This makes the dual-mode fallback pattern possible with `AbstractApiController`: the sync branch answers polls while a domain service broadcasts into a room the SSE branch joined. The new `ApiSseConnectionRegistry` bridges connections to a shared broadcaster, which can serve legacy controllers and `buildApiRoute` routes simultaneously.
  
  Room operations live beside the session rather than on it (`getSessionRooms(session)` rather than `session.rooms`) because `@lokalise/fastify-api-contracts` owns the `SSESession` shape in this path.
- f0999ee: Mark streaming routes in the gateway manifest and map `timeouts.idle` in all generators.
  
  - Routes built from SSE/dual-mode contracts are stamped with a streaming mode (non-enumerable `Symbol.for('opinionated-machine.route.streaming')`), and the manifest gains an optional `streaming: 'sse' | 'dual'` field. Legacy `AbstractSSEController`/`AbstractDualModeController` routes can be included via the new `buildGatewayManifest({ includeStreamingControllers: true })` opt-in.
  - Envoy: `timeouts.idle` maps to route-level `idle_timeout` (previously silently ignored); streaming routes default to `timeout: 0s` and `idle_timeout: 0s` so Envoy's defaults (15s route timeout, 5m stream idle timeout) no longer reset SSE streams; new `EnvoyOptions.streamIdleTimeout` configures the listener-wide HCM value; declaring `timeouts.request` on an SSE-only route warns (it bounds total stream lifetime). A dual-mode route is emitted as two Envoy routes — `<id>__sse`, matched on `Accept: text/event-stream`, and `<id>`, the catch-all — with the declared timeouts split between them (`timeouts.idle` to the stream branch, `timeouts.request` to the JSON branch) rather than applied to both, so disabling the timeouts a stream needs no longer strips every bound from the JSON poll branch.
  - Kong: `timeouts.idle` participates in the loosest-wins service `read_timeout`; streaming routes emit `response_buffering: false` (Kong ≥ 2.3); streaming routes without `timeouts.idle` warn that heartbeats must beat the effective `read_timeout`. Because that `read_timeout` is service-level, every co-located non-streaming route that inherits a raised value is now warned about by name, with the remedy (a separate `metadata.upstream` for streaming routes).
  - KrakenD: the endpoint `timeout` uses the looser of `timeouts.request`/`timeouts.idle`; streaming routes with neither warn about KrakenD's 2s default endpoint timeout.
  - The manifest's streaming fields follow the `@lokalise/api-contracts` vocabulary: `streaming: 'sse' | 'dual'` and `streamingDefaultMode: 'non-sse' | 'sse'`. The branch of a dual route that does not stream is a JSON body on most routes but can equally be a blob, and nothing in the manifest depends on which. Both fields describe the SUCCESS path: an error status answers with JSON on a streaming route too, including the early-return `sse.respond(404, ...)` path, so a generator sizes timeouts and buffering from them but must not assume the content type of a failure.
- f0999ee: Add monotonic event-id helpers for SSE streams: `createEventIdSequence()` produces lexicographically ordered ids (`"<epoch>-<zero-padded counter>"`) suitable for `Last-Event-ID` reconnection, client-side ordering, and the polling-fallback version gate; `compareEventIds()` orders ids within an epoch and returns `undefined` across epochs (a signal to resynchronize via a snapshot poll).
- f0999ee: Close the review findings on the SSE fallback stack: room authorization and revocation, bounded stream lifetimes, multi-writer event ids, and the client's give-up and re-auth paths.
  
  **Rooms (`opinionated-machine`)**
  
  - `sseRooms` accepts an options object (`{ broadcaster, authorizeJoin, maxSessionLifetimeMs }`) alongside the bare broadcaster. `authorizeJoin` declares the scope check once per route instead of trusting every handler body — a room name built from a path param was previously joined unchecked. `maxSessionLifetimeMs` closes the session after N ms, forcing a re-authorized reconnect.
  - `ApiSseConnectionRegistry` gained `evict(connectionId)`, `evictFromRoom(room, connectionId)` and `closeRoom(room)`. Authorization is checked when a stream opens and then goes stale, so revocation now has something to call: before this a revoked user kept receiving broadcasts until the tab closed.
  
  **Event ids (`opinionated-machine`, `@opinionated-machine/sse-rooms-redis`)**
  
  - `createEventIdSequence()` validates `start` (integer, in range, below the id width) and `epoch` (non-empty), and refuses to widen the counter past its zero padding. `start: 999_999_999_999` used to produce a 13-digit id that no longer sorted after its 12-digit predecessor.
  - New `createRedisEventIdSequence()` backs the counter with Redis `INCR` under one shared epoch. Per-process sequences are safe only for a single writer: two pods broadcasting into the same room use different epochs, and a client ordering by epoch first silently drops the older pod's events. The docs now state that hazard and recommend domain versions as the default id source. `@opinionated-machine/sse-rooms-redis` needs those exports, so its `opinionated-machine` peer range moves from `>=6.8.0` to `>=10.1.0` — a breaking change for anyone on an older framework version.
  - `formatEventId()` rejects an empty epoch, the way `createEventIdSequence()` already did: `'-000000000001'` is an id `compareEventIds()` cannot parse, so nothing downstream can order it.
  
  **Envoy (`@opinionated-machine/gateway-envoy`)**
  
  - Streaming routes emit a route-level `max_stream_duration`, default 30 minutes, configurable via `EnvoyOptions.maxStreamDuration` or per route with the new `timeouts.maxDuration`. With both the route timeout and the idle timeout disabled, a streaming route had an unbounded lifetime, so the authorization checked at connect never expired.
  - The dual-mode SSE branch honours `Accept` quality values: `text/event-stream;q=0` is a refusal and now takes the JSON branch, where `contains` alone matched it. A `defaultMode: 'sse'` route emits a second plain branch (`<id>__json_sse_refused`) for the same refusal, because there the stream is the catch-all and the JSON branch's `contains` exclusion cannot match a header that names the type only to refuse it.
  - The manifest carries `streamingDefaultMode`, and a route declaring `defaultMode: 'sse'` inverts the Envoy split so the stream is the catch-all. Previously a request with a missing or wildcard `Accept` header streamed on the server but got the JSON branch's request timeout at the gateway.
  
  **Fallback client (`@opinionated-machine/sse-fallback`)**
  
  - Stops carry a reason: `sub.result`, `sub.onStop()`, a second `onStatusChange` argument, and `SubscriptionStoppedError` from `waitFor`. `'stopped'` alone could not tell a completed job from an auth failure or a caller's own `stop()`.
  - `policy.subscriptionBudget` (`maxDurationMs` / `maxPolls`, unset by default) stops a subscription whose backend never leaves its pending state, with a `'budget-exhausted'` reason. Every individual wait was bounded; the subscription as a whole was not.
  - `onAuthChallenge` makes an auth refusal recoverable once: refresh credentials and the refused poll or connect runs again. A 401 in a SPA is usually an expired token, and killing the subscription contradicted recovering without a page reload.
  - `policy.mode: 'poll-only'` (and the `POLL_ONLY_POLICY` preset) never opens a stream, so a backend can adopt the binding, version gate and state machine before its SSE endpoint exists.
  - `openStream` may resolve with `events: AsyncIterable<ParsedSseFrame>` instead of raw `chunks`, so adapters can wrap `EventSource` or an HTTP client that only exposes framed events. `staleConnectionTimeoutMs` degrades to event-level liveness in that mode; correctness is unaffected.
  - New `createPollGate()` caps and staggers reconciliation polls across subscriptions sharing one origin. Per-subscription jitter did nothing about a fleet-wide reconnect firing every subscription's poll on the same tick.
  - A throwing event/state/status listener no longer aborts the delivery loop or surfaces as a transport failure; faults go to `diagnostics.onListenerError`.
  - A gap-suspended state layer is repaired by any snapshot, not only one whose version matches the watermark exactly. Live events kept advancing the watermark after a gap, so the repair snapshot arrived below it, `apply` stayed disabled and `getState()` froze at its pre-gap value forever. The suspension is now reported on the outcome and through `diagnostics.onStateSuspended` / `onStateRepaired`. Events delivered during the suspension that the repair snapshot predates are replayed onto it, so a repair at revision 4 no longer drops a revision 5 that was already delivered; if more arrive than the buffer holds, the suspension holds until a snapshot reaches the watermark rather than dropping them silently.
  - Snapshot-synthesized events stop at the terminal event, matching `handleEvent` and `finishHydration`.
  - Version comparison no longer coerces unsafe integer strings through `Number()`: `9007199254740992` and `9007199254740993` collapsed to the same double, so the second event was dropped as a duplicate.
  - Abandoned hydration no longer reports a byte-less stream as `'live'`; bytes are what promote the subscription.
- f0999ee: Expose raw SSE chunks on `SSEHttpClient` and fix CRLF framing in `parseSSEBuffer`.
  
  - `SSEHttpClient` gained an `onRawChunk` hook that observes raw stream chunks as they arrive, including the `: heartbeat` comment frames the SSE parser drops. Useful for asserting heartbeat delivery and for byte-level liveness checks in tests.
  - `parseSSEBuffer` handles CRLF-framed streams: the blank separator line kept a trailing `\r`, so consecutive events merged into one with the wrong id and concatenated data.
- f0999ee: Close the third round of review findings on the SSE fallback stack.
  
  **SSE parser**
  
  - Field values follow the spec: exactly one leading space is removed after the colon and the rest is preserved. `trim()` was corrupting `data:  keep spaces  `, which matters for any decoder that reads the raw string instead of JSON.
  - CR, LF and CRLF are all line terminators. A CR at the end of the buffer is held back until the next chunk says whether it was half of a CRLF.
  - `retry:` accepts ASCII digits only. `parseInt` was reading `100x` as 100.
  - A blank line dispatches even with no data, so `id: reset\n\n` moves the Last-Event-ID cursor instead of leaking its id onto the next event, and an empty `id:` clears the cursor. `parseSSEBuffer(buffer, lastEventId)` takes the cursor in and returns it, and each event reports the cursor as of its dispatch in `lastEventId`.
  
  **Event ids (`opinionated-machine`, `@opinionated-machine/sse-rooms-redis`)**
  
  - `createEventIdSequence()`, `formatEventId()` and `createRedisEventIdSequence()` require a numeric epoch. `epoch: 'deploy-blue'` produced `deploy-blue-000000000001`, which the client's default version extractor reads as versionless: the same id delivered twice was not a duplicate, so dedup, gap detection and stale-poll protection were silently off. Restricting the epoch is what makes `<digits>-<digits>` an unambiguous marker for a generated id, since a UUID matches `<anything>-<digits>` too.
  
  **Fallback client (`@opinionated-machine/sse-fallback`)**
  
  - An epoch change is reported as a gap with `reason: 'epoch-change'` instead of being swallowed, so the subscription polls and suspends delta state and repairs from a snapshot. Applying deltas across a writer restart was silent, and a busy stream kept the deadman moving so the repair never came. Gaps from a skipped counter carry `reason: 'sequence'`.
  - A poll and a reconnect refused by the same expired token share one in-flight `onAuthChallenge` refresh. The second refusal used to see the retry already spent and stop the subscription while the refresh was still running; only a refusal after the refresh completes counts as the second failure now.
  
  **Rooms (`opinionated-machine`)**
  
  - A join whose async `authorizeJoin` verdict is still pending is cancelled by `leave`, `evictFromRoom`, `evict`, `closeRoom` and the session closing. The resolved verdict used to add the connection to a room it had just been removed from, so the revocation silently did not stick. `evictFromRoom` returns `true` when it cancels a pending join.
  
  **Envoy (`@opinionated-machine/gateway-envoy`)**
  
  - A dual-mode route emits a `<id>__negotiated` branch for an `Accept` header that names both `application/json` and `text/event-stream` as acceptable. The server ranks them by quality (and by header order on a tie), which RE2 header matchers cannot reproduce, so `application/json;q=0.9, text/event-stream;q=0.1` took the stream branch and ran the JSON poll with `timeout: 0s`. The stream branches are now narrowed to the cases the gateway can decide, and the negotiated branch carries bounds safe for either mode: no total-lifetime bound, plus an idle bound from `timeouts.idle` or `timeouts.request`. A route declaring `timeouts.request` warns that it cannot be enforced there.

### Patch Changes

- f0999ee: Stop `ApiSseConnectionRegistry` from retaining pending-join state for dead connections.
  
  `unregister` and `evict` cancelled a connection's in-flight `authorizeJoin` tokens but left the map entry behind. The entry is normally removed when the verdict settles, so a verdict that never resolves kept the connection id and its tokens alive after the session was gone, and `closeRoom` walked the retained keys. Both paths now delete the entry; cancellation rides on the token object the join closure captured, so a late verdict still settles as revoked.
- Updated dependencies [f0999ee]
- Updated dependencies [f0999ee]
  - @opinionated-machine/sse-parser@0.1.0

## 10.5.0

### Minor Changes

- c2c7154: Read SSE responses as they are written, and with the contract's typing, on both test paths.
  
  - `injectApiSSE` now injects with Fastify's `payloadAsStream` and exposes `head` (status and headers, as soon as the handler calls `sse.start()`) and `stream(signal?)`, which yields the contract's typed, validated events as the handler writes them. Progressive delivery can be asserted without `app.listen()`, a base URL or manual connection cleanup. `closed`, `events()` and `bodyForStatus()` are unchanged.
  - `connectApiSSE(baseUrl, contract, params, options?)` connects over real HTTP using the contract for method, path, query params, headers and body, and reads the stream as the same discriminated union `injectApiSSE().events()` returns. `SSEHttpClient` gained `apiEvents(contract, signal?)` and `collectApiEvents(contract, countOrPredicate, timeout?)` for connections that already exist.
  - A payload that fails its SSE event schema no longer reaches the test as an event that is simply missing: routes built with `buildApiRoute` report the failed send — event name, Zod issues and payload — to the helper reading the stream. A failure that ended the stream early is thrown by `events()` / `stream()` / the `connectApiSSE` readers; one the route caught and streamed around is recorded instead, so a handler with a working fallback keeps passing. `injectApiSSE(...).sendFailures()` and `connectApiSSE(...).sendFailures()` expose every record, `handled` flag included. Test-only, keyed on a header that only the helpers produce and that is ignored unless it names a diagnostics scope open in the same process.
  - `connectApiSSE`'s readers reject a response that is not an event stream with its status and body, instead of waiting out the collection timeout on a stream that was never going to arrive, and invoke a caller's `collectEvents` predicate exactly once per event.

## 10.4.0

### Minor Changes

- 8a388e7: Expose the response body on `SSEInjectConnection`: `getBody()` returns the raw body string and `json<T>()` parses it as JSON, mirroring Fastify's inject response. This lets tests using the untyped `SSEInjectClient` assert on JSON error bodies that an SSE route sends before streaming starts (auth failures, validation errors, unavailable integrations), which previously were unreachable.

## 10.3.0

### Minor Changes

- 197d746: Support non-GET requests in `SSEHttpClient.connect()` via new `method` and `body` connect options, so POST/PUT/PATCH SSE endpoints can be tested over real HTTP instead of only through `SSEInjectClient`. `method` is accepted in either case, matching the lowercase spelling used by route contracts. Bodies `fetch()` sends natively (strings, `URLSearchParams`, `FormData`, `Blob`, `ArrayBuffer`, typed arrays, `ReadableStream`) are passed through untouched, everything else is JSON-stringified, and `content-type: application/json` is only defaulted when it does not overwrite an encoding `fetch()` describes itself. The response body is now locked lazily, so `client.response.json()` still works for endpoints that answered with a regular HTTP response (e.g. an error raised before `sse.start()`), and a bodiless response is reported when events are consumed rather than from `connect()`. `awaitServerConnection` now matches the request method as well as the URL, so a path served by both a GET and a POST route resolves the right session; `SpiedSSESession` accordingly requires `request.method`, which every Fastify-backed session already carries.
- 197d746: Type `SSEConnectOptions.method` as the new exported `SSEInjectMethod`, derived from Fastify's own inject options instead of a hand-listed `'GET' | 'POST' | 'PUT' | 'PATCH'` union. `SSEInjectClient.connectWithBody()` now accepts every method `inject()` accepts (including `DELETE`, `HEAD`, `OPTIONS` and the lowercase spellings), and consumers can import the union instead of redeclaring it.

## 10.2.0

### Minor Changes

- 9a9a89d: Add `injectApiSSE`, a contract-typed SSE inject helper for contracts built with `defineApiContract` + `sseResponse`/`sseBody`. The existing `injectSSE`/`injectPayloadSSE` are typed against the legacy `SSEContractDefinition` and reject the newer contract shape. `injectApiSSE` covers every HTTP method from the contract, takes the same params as `injectByApiContract`, resolves `bodyForStatus` schemas from `responsesByStatusCode` (exact → range → `default` precedence), and adds `events()` for events parsed and validated against the contract's SSE schemas, merged across every declared status. The request always asks for `text/event-stream`, so statuses that declare a stream — dual-mode ones included — are excluded from `bodyForStatus`, and `events` is typed `never` for contracts that declare no SSE response.

## 10.1.0

### Minor Changes

- 45dd012: Add `createSSESessionSpy()` testing factory so `buildApiRoute` routes can use `SSEHttpClient`'s `awaitServerConnection`. It returns a standalone `SSESessionSpy`, `{ onConnect, onClose }` route options to spread into a route with no lifecycle hooks of its own, and a `withSpy()` helper that merges the spy into a route's existing options by chaining rather than replacing its `onConnect` / `onClose`. `awaitServerConnection` now accepts `{ spy }` alongside `{ controller }`, and `SSESessionSpy` is generic over the observed session type, defaulting to the previous one.

### Patch Changes

- 45dd012: Fix `SSEHttpClient.connect()` leaking the open SSE response when `awaitServerConnection` times out. The caller never received a client handle, so a keep-alive stream stayed open and hung the test's `app.close()`, hiding the original timeout behind a suite-level timeout. A `waitForConnection` timeout now also explains itself when matching connections were registered but had already closed, which is what an `autoClose` session looks like to the spy.

## 10.0.0

### Major Changes

- d06517a: Replace the silently-ignored per-route `heartbeatInterval` SSE option with `heartbeat: boolean`.
  
  `@fastify/sse` has no per-route `heartbeatInterval`: the route-level knob is `heartbeat`, a boolean
  that can only turn the heartbeat off, while the interval is a plugin-registration option shared by
  all routes. The route builder was copying `heartbeatInterval` onto the route's `sse` option, where
  the plugin never read it — so `buildHandler(contract, handlers, { heartbeatInterval: 5000 })`
  type-checked, ran, and did nothing, and there was no way to disable the heartbeat for a single route.
  
  Breaking changes:
  
  - `FastifySSERouteOptions` / `FastifyDualModeRouteOptions`: `heartbeatInterval?: number` is replaced
    by `heartbeat?: boolean`. Set `heartbeat: false` to suppress heartbeat comments on a route.
  - `RegisterSSERoutesOptions` / `RegisterDualModeRoutesOptions`: `heartbeatInterval?: number` is
    likewise replaced by `heartbeat?: boolean`. These options are applied to individual routes, not to
    plugin registration, so they could never carry an interval either.
  
  Configure the interval where it actually works, once for all routes:
  `app.register(fastifySSE, { heartbeatInterval: 30000 })`.
  
  Also fixes the registration-level `heartbeat` / `serializer` defaults from `registerSSERoutes()` and
  `registerDualModeRoutes()`, which were written to `config.sse` — a location `@fastify/sse` never
  reads — and are now merged into the top-level `sse` route option, with per-route values taking
  precedence.

### Minor Changes

- e935a42: Register SSE and dual-mode routes with an explicit `@fastify/sse` kind of `'manual'` instead of falling back to the plugin's `'legacy'` kind.
  
  Previously `buildFastifyRoute` emitted `sse: true` (or an options object without `kind`), which resolves to `'legacy'` and applies a strict `Accept` gate: a client that did not send an explicit `text/event-stream` token — a wildcard `Accept` header, `Accept: application/json`, or no `Accept` header at all — reached the SSE handler with `reply.sse` undefined, so the first `sse.start()` threw and the request returned a 500. The same applied to dual-mode routes configured with `defaultMode: 'sse'`. With `'manual'` there is no plugin-side negotiation: `reply.sse` is always attached and the handler decides whether to stream, which is what these route handlers already do.
  
  Adds a `kind` route option so the default can be overridden, restricted per route type to the kinds that can actually work:
  
  - SSE-only routes accept `'manual' | 'only'` (`SSEOnlyRouteKind`). `'only'` makes the plugin content-negotiate and answer `406 Not Acceptable` before the handler runs; note its gate admits a missing `Accept` header and the `*/*` and `text/*` wildcards but rejects every other concrete media type, `application/json` included.
  - Dual-mode routes accept `'manual' | 'dual'` (`DualModeRouteKind`). Combining `kind: 'dual'` with `defaultMode: 'sse'` now throws at route-build time instead of returning a 500 per request, because the plugin's gate and the handler's own `determineMode()` disagree for wildcard or absent `Accept` headers.
  
  Also stops the SSE teardown path from masking errors: `closeSSESession` re-read `reply.sse.isConnected` from inside its own `catch`, which raised a second `TypeError` and replaced the original failure, and `sse.start()` now marks the session started only after its first successful `reply.sse` access.

## 9.1.0

### Minor Changes

- a806edc: Document SSE and dual-mode route responses in the generated OpenAPI spec.
  
  `buildFastifyRoute` left `schema.response` empty for `AbstractSSEController` and
  `AbstractDualModeController` routes, so the spec showed a bare "Default Response" with no
  event shapes and no error bodies, even though the same contract data was already used for
  runtime validation. Both builders now derive `schema.response` from the contract: 200
  describes the event stream under `text/event-stream` (one `{ id?, event, data, retry? }`
  envelope per event, as a `oneOf` with the event name pinned to a `const`, matching what
  `@lokalise/fastify-api-contracts` emits for `sseBody()`) plus the JSON body under
  `application/json`, and each status in `responseBodySchemasByStatusCode` gets its declared
  schema.
  
  Statuses that more than one body shape can reach accept all of them, since Fastify rejects
  anything the schema does not cover: a dual-mode 2xx accepts both `successResponseBodySchema`
  (the `sync` handler) and the schema declared for that status (`sse.respond()`), and a non-2xx
  accepts the framework error envelope alongside the declared body, so declaring a 400 no longer
  turns a failed request validation into a 500. Errors the builders raise themselves before
  streaming starts are sent pre-serialized and skip the schema, keeping the thrown error's
  message intact.
  
  This puts Fastify's serializer in the path for the status codes a contract declares. A
  response body that previously went out through plain `JSON.stringify` is now serialized
  against its contract schema, so keys the schema does not declare are dropped.

## 9.0.0

### Major Changes

- d6da03e: Adopt mandatory contract visibility (`@lokalise/api-contracts` v8):
  
  - Raise peer dependency floors to `@lokalise/api-contracts` >= 8.0.0 (visibility is now a required
    field of every contract builder config) and `@lokalise/fastify-api-contracts` >= 7.0.0.
  - Derive the fastify-swagger `hide` flag from contract `visibility` in the SSE and dual-mode route
    builders, failing closed: only `visibility: 'public'` contracts appear in generated OpenAPI docs.
    Anything else — `'internal'`, or a contract that lacks the field at runtime because it was compiled
    against a pre-visibility `@lokalise/api-contracts` — sets `schema.hide: true` and is excluded,
    matching `@lokalise/fastify-api-contracts`. The same builders now also map the contract's
    `description`, `summary` and `tags` to the route schema; previously these fields were dropped and
    the routes appeared undocumented.
  - Remove the unused `visibility` field from the gateway metadata schema. No generator consumed it
    and it collided with the (unrelated) contract `visibility` — a docs-internal BFF route can still
    be gateway-public, so the two concepts cannot be derived from each other. If gateway-level
    exposure classification is needed later, it will be reintroduced under a non-colliding name
    (e.g. `exposure`). The metadata schema is strict, so passing `visibility` now fails loudly.

## 8.0.0

### Major Changes

- de12db0: Replace the local ApiContract route builder with `buildFastifyApiRoute` from `@lokalise/fastify-api-contracts` (>=6.0.0, now the source of the route-building, handler inference, response validation, and SSE streaming logic). `buildApiRoute` remains as a thin wrapper that only adds the contract-narrowed `gatewayMetadata` option.
  
  Breaking changes:
  
  - Handlers now use the package's unified `(request, reply, context) => { status, body }` shape for every response mode. SSE streaming is driven via `context.sse.start(...)` (or by returning an `AsyncIterable` body for an SSE status); dual-mode `{ nonSse, sse }` handler objects and `sse.respond()` / `sse.sendHeaders()` are gone — branch on `context.expectedContentType` and return `{ status, body }` for early HTTP responses.
  - `ApiNonSseHandler`, `ApiSseHandler`, `InferApiRequest`, and `InferApiStatusResponse` are removed; `InferApiHandler`, `InferApiHandlerRequest`, `InferApiHandlerResult`, `ApiHandlerContext`, and `ApiHandlerReply` are re-exported from `@lokalise/fastify-api-contracts` instead.
  - `buildApiRoute` options: `defaultMode` is removed (use `context.expectedContentType`). `heartbeatInterval` is removed — per-route heartbeat intervals are no longer possible: the package's `heartbeat` option is a boolean that only enables/disables the heartbeat for a route, and the interval itself is configured once for all routes at `@fastify/sse` plugin registration (`heartbeatInterval`, default 30000 ms).
  - Response body validation is delegated to the `fastify-type-provider-zod` serializer compiler — apps must register `validatorCompiler` / `serializerCompiler`. This applies to every ApiContract route, not just JSON ones: the package emits a Zod response schema for every declared status (including `sseBody()` and `noBodyResponse()`, which previously produced no response schema), so an app missing `setSerializerCompiler` now fails at boot during route registration — even for SSE-only contracts — with `FST_ERR_SCH_SERIALIZATION_BUILD: Failed building the serialization schema … schema is invalid: data/required must be array`. If you hit that error, register the zod compilers. Peer ranges bumped: `@lokalise/fastify-api-contracts` >=6.0.0, `fastify-type-provider-zod` >=7.0.0.
  - Error handling is delegated to the app's global `fastify.setErrorHandler` (per the `@lokalise/fastify-api-contracts` README), including for SSE routes: the route builder no longer maps the node-core `httpStatusCode` error convention (`PublicNonRecoverableError`, `InternalError`, …) onto responses — such errors now reach the error handler unmapped and default to 500 — and no longer emits a terminal SSE `error` event when a handler throws after `sse.start()`. Note the resulting cross-system split: legacy `buildFastifyRoute` / SSE / dual-mode routes still honor `httpStatusCode` internally, so an app mixing both route families maps the same error to different statuses. Install a global error handler that maps `httpStatusCode` (and, if your clients rely on it, emits the terminal SSE `error` event) before upgrading.
  - The `SSESession` / `SSEContext` / `SSESessionMode` / `FastifySSERouteOptions` types exported from the package root still resolve to the legacy `lib/routes` types and no longer match what `buildApiRoute` handlers and lifecycle hooks (`onConnect` / `onClose`) actually receive — the package's session has no `rooms` / `eventSchemas`, an optional `context`, adds `close()`, and its context has no `respond()` / `sendHeaders()`. When typing `buildApiRoute` sessions, contexts, or hooks explicitly, import these types from `@lokalise/fastify-api-contracts` directly; the root exports keep typing the legacy `AbstractSSEController` / `AbstractDualModeController` routes.

## 7.0.0

### Major Changes

- e3a05b6: Require `@lokalise/api-contracts` >= 7.0.0. The route builder no longer handles the legacy response entries removed in api-contracts 7 (`anyOfResponses`, `sseResponse`/`blobResponse`/`textResponse` tagged objects, `ContractNoBody` as a response) — declare responses with bare Zod schemas, `noBodyResponse()`, or content maps (`{ content: { 'text/event-stream': sseBody(...) } }`). Handler body types are now also inferred from content-map entries (JSON media types resolve to their Zod output type, blob to `Blob`, `allowNoBody` to `undefined`).

## 6.20.3

### Patch Changes

- 22a290b: Migrate release automation to Changesets.
