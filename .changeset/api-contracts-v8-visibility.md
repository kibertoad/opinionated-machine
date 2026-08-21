---
"opinionated-machine": major
---

Adopt mandatory contract visibility (`@lokalise/api-contracts` v8):

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
