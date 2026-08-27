---
"opinionated-machine": minor
---

Generate public and internal OpenAPI documents from the same routes.

Contract `visibility` currently makes hiding a one-way decision: route builders set
`schema.hide: true` for anything that is not `visibility: 'public'`, which keeps internal endpoints
out of the customer-facing spec but also out of any document internal teams could use.

- `buildApiRoute` and the SSE / dual-mode `buildFastifyRoute` now record the contract's `visibility`
  on the route schema next to `hide`, so a transform can tell *why* a route is hidden. The key is
  not `x-` prefixed, so it never reaches a generated document.
- New `openApiVisibilityTransform({ audience })` — a `@fastify/swagger` `transform` that re-derives
  `hide` per audience. Register the plugin once per audience with different `decorator` names to get
  both documents from one route table. Internal operations are marked `x-internal: true` in the
  internal document. Chain `jsonSchemaTransform` through its `transform` option: it short-circuits on
  `hide`, so the audience decision has to run first. Routes with no visibility marker but
  `hide: true` (those built directly by `@lokalise/fastify-api-contracts`) are treated as internal by
  default; `treatHiddenAsInternal: false` opts out, and the `X-HIDDEN` tag stays the
  audience-independent way to hide a route from both documents.
- New `stripInternalOperations(document)` derives the public document from an internal one for
  services that cannot register `@fastify/swagger` twice. It removes marked operations, drops path
  items left empty, and prunes `components.schemas` entries and tags nothing public references any
  more, without mutating the input.
- New optional `fastifyOpenApiDocsPlugin` serves each document under its own path. Both routes are
  opt-in, the internal one takes guard hooks, and the document routes stay out of every document.
- New `attachRouteVisibility` / `readRouteVisibility` for stamping routes built outside this package.

Defaults are unchanged: a service that does not add a transform keeps hiding internal endpoints
exactly as before.
