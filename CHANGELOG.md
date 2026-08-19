# opinionated-machine

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
