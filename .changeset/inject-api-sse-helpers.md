---
"opinionated-machine": minor
---

Add `injectApiSSE`, a contract-typed SSE inject helper for contracts built with `defineApiContract` + `sseResponse`/`sseBody`. The existing `injectSSE`/`injectPayloadSSE` are typed against the legacy `SSEContractDefinition` and reject the newer contract shape. `injectApiSSE` covers every HTTP method from the contract, takes the same params as `injectByApiContract`, resolves `bodyForStatus` schemas from `responsesByStatusCode` (exact → range → `default` precedence), and adds `events()` for events parsed and validated against the contract's SSE schemas, merged across every declared status. The request always asks for `text/event-stream`, so statuses that declare a stream — dual-mode ones included — are excluded from `bodyForStatus`, and `events` is typed `never` for contracts that declare no SSE response.
