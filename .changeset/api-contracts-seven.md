---
"opinionated-machine": major
---

Require `@lokalise/api-contracts` >= 7.0.0. The route builder no longer handles the legacy response entries removed in api-contracts 7 (`anyOfResponses`, `sseResponse`/`blobResponse`/`textResponse` tagged objects, `ContractNoBody` as a response) — declare responses with bare Zod schemas, `noBodyResponse()`, or content maps (`{ content: { 'text/event-stream': sseBody(...) } }`). Handler body types are now also inferred from content-map entries (JSON media types resolve to their Zod output type, blob to `Blob`, `allowNoBody` to `undefined`).
