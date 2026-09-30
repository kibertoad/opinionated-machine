---
"opinionated-machine": major
"@opinionated-machine/sse-fallback": major
---

Drop support for legacy contracts, following `@lokalise/api-contracts@9` and `@lokalise/fastify-api-contracts@8`, which removed them. Contracts are defined with `defineApiContract`, and `AbstractApiController` + `asApiControllerClass` + `buildApiRoute` is the only controller type. It serves sync JSON, SSE and dual-mode routes, all registered by `DIContext.registerRoutes()`.

The peer dependencies are raised to `@lokalise/api-contracts@>=9.0.0` and `@lokalise/fastify-api-contracts@>=8.0.0`. With `@lokalise/fastify-api-contracts@8`, an error thrown after `sse.start()` reaches the app's global error handler with the stream still open, so an app serving SSE routes must register an SSE-aware `setErrorHandler` (one that sends a terminal `error` event and closes the stream once headers are sent, like the `fastify-extras` error handler). Fastify's default handler cannot write to a started stream and leaves it open. When a handler loses a send and the error handler then ends the stream with an `error` event the contract does not declare, `injectApiSSE(...).stream()` and `connectApiSSE(...).events()` report the lost send instead of the undeclared event.

`opinionated-machine` removes:

- `AbstractController` and `BuildRoutesReturnType`, `AbstractSSEController`, `AbstractDualModeController`, and `asControllerClass`, `asSSEControllerClass` and `asDualModeControllerClass`. Use `AbstractApiController` with `asApiControllerClass`. `DIContext` now throws when `resolveControllers()` returns a controller that was not registered with `asApiControllerClass`.
- The legacy route builder and its types: `buildFastifyRoute`, `buildHandler`, `SSEContext`, `FastifySSERouteOptions`, `FastifyDualModeRouteOptions`, `RegisterSSERoutesOptions`, `RegisterDualModeRoutesOptions`, `buildSseEventSchema`, `buildSseResponseSchemas`, `determineMode` and the rest of the former `routes` and `dualmode` exports. Use `buildApiRoute`.
- `DIContext.registerSSERoutes()`, `registerDualModeRoutes()`, `hasSSEControllers()` and `hasDualModeControllers()`. `registerRoutes()` registers SSE and dual-mode routes too; register `@fastify/sse` on the app first. Open keepAlive streams are closed by the `preClose` hook `registerRoutes()` installs, which replaces the legacy controllers' `closeAllConnections` dispose.
- `DependencyInjectionOptions.isTestMode`, and `awaitServerConnection: { controller }` / `HasSessionSpy` / `SSEHttpConnectWithSpyOptions` in `SSEHttpClient.connect`. Wire a spy into the route with `createSSESessionSpy()` and pass `awaitServerConnection: { spy }`.
- `injectSSE`, `injectPayloadSSE`, `InjectSSEOptions`, `InjectPayloadSSEOptions` and `InjectSSEResult`. Use `injectApiSSE`.
- `SSEEventSender`, `SSEControllerConfig`, and the re-exports of the legacy `@lokalise/api-contracts` types (`SSEContractDefinition`, `AnySSEContractDefinition`, `DualModeContractDefinition`, `AnyDualModeContractDefinition`, `SSEEventSchemas`, `SSEMethod`, `AllContractEventNames`, `ExtractEventSchema`, `AllContractEvents`). `SseSchemaByEventName` from `@lokalise/api-contracts` replaces `SSEEventSchemas`.
- `BuildGatewayManifestOptions.includeStreamingControllers` and the `kind` field of `CollectedController`, which is now `{ name, controller }`. `withGatewayMetadata` accepts only `ApiContract` contracts.

`@opinionated-machine/sse-fallback` removes `fromLegacyDualModeContract` and the `InferLegacyEvents` / `InferLegacySnapshot` types. `defineFallbackBinding` and `bindFallbackContracts` no longer accept contracts built with `buildSseContract`.
