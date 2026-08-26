---
"opinionated-machine": minor
---

Document SSE and dual-mode route responses in the generated OpenAPI spec.

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
