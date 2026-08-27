# opinionated-machine

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
