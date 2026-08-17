---
"opinionated-machine": major
---

Replace the local ApiContract route builder with `buildFastifyApiRoute` from `@lokalise/fastify-api-contracts` (>=6.0.0, now the source of the route-building, handler inference, response validation, and SSE streaming logic). `buildApiRoute` remains as a thin wrapper that only adds the contract-narrowed `gatewayMetadata` option.

Breaking changes:

- Handlers now use the package's unified `(request, reply, context) => { status, body }` shape for every response mode. SSE streaming is driven via `context.sse.start(...)` (or by returning an `AsyncIterable` body for an SSE status); dual-mode `{ nonSse, sse }` handler objects and `sse.respond()` / `sse.sendHeaders()` are gone — branch on `context.expectedContentType` and return `{ status, body }` for early HTTP responses.
- `ApiNonSseHandler`, `ApiSseHandler`, `InferApiRequest`, and `InferApiStatusResponse` are removed; `InferApiHandler`, `InferApiHandlerRequest`, `InferApiHandlerResult`, `ApiHandlerContext`, and `ApiHandlerReply` are re-exported from `@lokalise/fastify-api-contracts` instead.
- `buildApiRoute` options: `defaultMode` is removed (use `context.expectedContentType`), `heartbeatInterval` is replaced by the package's `heartbeat` flag.
- Response body validation is delegated to the `fastify-type-provider-zod` serializer compiler — apps must register `validatorCompiler` / `serializerCompiler`. Peer ranges bumped: `@lokalise/fastify-api-contracts` >=6.0.0, `fastify-type-provider-zod` >=7.0.0.
- Error handling is delegated to the app's global `fastify.setErrorHandler` (per the `@lokalise/fastify-api-contracts` README), including for SSE routes: the route builder no longer maps the node-core `httpStatusCode` error convention onto responses (such errors now reach the error handler unmapped and default to 500) and no longer emits a terminal SSE `error` event when a handler throws after `sse.start()`. Implement both in the global error handler if your clients rely on them.
