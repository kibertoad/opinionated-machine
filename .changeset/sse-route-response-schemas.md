---
"opinionated-machine": minor
---

Document SSE and dual-mode route responses in the generated OpenAPI spec.

`buildFastifyRoute` left `schema.response` empty for `AbstractSSEController` and
`AbstractDualModeController` routes, so the spec showed a bare "Default Response" with no
event shapes and no error bodies, even though the same contract data was already used for
runtime validation. Both builders now derive `schema.response` from the contract: 200
describes the event stream under `text/event-stream` (one `{ id?, event, data, retry? }`
envelope per event, unioned, matching what `@lokalise/fastify-api-contracts` emits for
`sseBody()`) plus the dual-mode sync body under `application/json`, and every status in
`responseBodySchemasByStatusCode` is passed through.

This puts Fastify's serializer in the path for the status codes a contract declares. A
response body that previously went out through plain `JSON.stringify` is now serialized
against its contract schema, so keys the schema does not declare are dropped. Bodies that
already matched their schema are unaffected.
