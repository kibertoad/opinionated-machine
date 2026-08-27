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
  audience-independent way to hide a route from both documents. `exclude` is that same escape hatch
  for routes whose schema the service does not own — most importantly the asset routes a
  documentation UI registers for itself, which are hidden with `schema.hide` and would otherwise
  surface in the internal document.
- New `stripInternalOperations(document)` derives the public document from an internal one for
  services that cannot register `@fastify/swagger` twice. It removes marked operations, drops path
  items left empty, and prunes `components` entries and tags nothing public references any more,
  without mutating the input. Reachability is resolved transitively across the whole `components`
  object, so a schema reachable only through a shared `components.responses` (or `parameters`,
  `requestBodies`, …) entry survives with it instead of being pruned out from under a live `$ref`.
  `components.securitySchemes` is never pruned, since security schemes are referenced by name rather
  than by `$ref`.
- Both `openApiVisibilityTransform` and `stripInternalOperations` reject an internal marker key that
  does not start with `x-`. `@fastify/swagger` copies only `x-`-prefixed schema keys into the
  generated operation, so any other key would silently never reach the document, leaving
  `stripInternalOperations` nothing to match on and publishing every internal operation as the
  public spec.
- New `pruneUnreachableComponents(document)` drops every `components` entry a document no longer
  references. Needed alongside `fastify-type-provider-zod`'s `jsonSchemaTransformObject`, which
  writes the whole Zod registry into `components.schemas` in one pass over the finished document and
  never sees which operations the audience transform hid — so without it the customer-facing
  document carries internal request and response shapes even though its operations are correctly
  filtered. Chain it as `transformObject: (input) => pruneUnreachableComponents(jsonSchemaTransformObject(input))`.
  `stripInternalOperations` already prunes as part of its own pass. Both documentation UIs render
  their Models panel straight from `components.schemas`, so this is what keeps an internal model
  from being visible to anyone browsing the public reference. Pruning keeps only the direction of
  each `Foo` / `FooInput` pair that is actually used, and is cycle-safe for self-referential
  schemas. Where a document deliberately publishes models no operation references, per-audience Zod
  registries (`createJsonSchemaTransform` / `createJsonSchemaTransformObject` both take a
  `schemaRegistry`) give explicit per-document model sets instead; the README covers both and when
  to pick which.
- `stripInternalOperations` and `pruneUnreachableComponents` take an unconstrained document type
  parameter. `openapi-types`' `Document` interfaces have no index signatures, so a structural
  constraint rejected `app.swagger()` — the one argument that matters.
- New `attachRouteVisibility` / `readRouteVisibility` for stamping routes built outside this package.

No documentation-serving plugin ships with this: `@fastify/swagger-ui` and
`@scalar/fastify-api-reference` can each be registered twice, one instance per audience, and the
README documents both recipes.

Defaults are unchanged: a service that does not add a transform keeps hiding internal endpoints
exactly as before.
