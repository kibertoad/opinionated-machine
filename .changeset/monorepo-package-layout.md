---
"opinionated-machine": patch
---

Move the framework's sources from the workspace root into `packages/opinionated-machine`, so every
package in the repo lives under `packages/*`.

The published contents are unchanged: same entry points, same `files`, same README and CHANGELOG.
`repository.directory` now points at the package, and the workspace root is private and holds only
the orchestration scripts (`build:all`, `lint:all`, `test:all`, `changeset`, `ci:publish`) plus the
shared `tsconfig.json`, `biome.jsonc` and `turbo.jsonc` every package extends.

`@opinionated-machine/sse-fallback` is now a declared devDependency of the framework package rather
than a relative path into a sibling directory, which is what lets turbo order and hash the suite
that integrates against it.
