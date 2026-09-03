---
"opinionated-machine": patch
"@opinionated-machine/sse-fallback": patch
---

Orchestrate workspace tasks with Turborepo.

`turbo.jsonc` declares each task's dependencies, inputs and outputs, so ordering follows the
workspace graph instead of hand-written `pnpm --filter` chains. The per-package `build` scripts
lost their `pnpm --filter @opinionated-machine/sse-parser run build` prefix and now compile
exactly one package; `pnpm run build:all` and `pnpm run lint:all` drive the whole graph.

Keeping the per-package `build` scripts single-package also keeps `prepublishOnly` safe: changesets
publishes chunk-mates concurrently, so a hook that rebuilt sibling packages would `rimraf` a `dist`
that another `pnpm publish` was packing at that moment.
