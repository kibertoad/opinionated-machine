# Contributing to opinionated-machine

## Rules

There are a few basic ground-rules for contributors:

1. **Non-main branches** ought to be used for ongoing work.
2. Contributors should attempt to adhere to the prevailing code-style.
3. Before submitting a PR for a major new feature, or introducing a significant change, please open an issue to discuss the proposal with maintainers.

## Monorepo tasks

Tasks are orchestrated by [Turborepo](https://turborepo.dev). `turbo.jsonc` declares what each
task depends on, so ordering follows the workspace graph rather than hand-written `pnpm --filter`
chains: `@opinionated-machine/sse-parser` builds before `opinionated-machine`, and
`opinionated-machine` builds before the gateway and rooms adapters.

| Command | What it does |
| --- | --- |
| `pnpm run build:all` | Builds every package in dependency order |
| `pnpm run lint:all` | Runs `biome check` and `tsc` in every package, plus `biome check` over the workspace root |
| `pnpm run test:all` | Runs every package's test suite |
| `pnpm exec turbo run test:ci` | Runs `opinionated-machine`'s suite with coverage |
| `pnpm exec turbo run test --filter=<package>` | Tests one package, building what it depends on first |

Invoked from inside a package directory, turbo scopes to that package on its own, so
`cd packages/sse-fallback && pnpm exec turbo run test` builds the parser first and then tests only
the fallback client.

The per-package `build`, `lint` and `test` scripts still exist and still do exactly one package's
work. They assume their dependencies are already built, which is what `build:all` is for.

Results are cached under `.turbo`, keyed on each task's declared inputs. Pass `--force` to ignore
the cache for a run.

Tasks that depend on something outside their hash are not cached at all: the gateway acceptance
suites and `packages/sse-rooms-redis`'s tests need a live container, and a cache hit would report a
pass without ever starting one.

## Changesets

This repo uses [Changesets](https://github.com/changesets/changesets) to automate versioning and releases.

If your PR affects anything used by consumers (API, types, runtime behavior, or usage-facing docs), add a changeset by **creating the file manually**.

1. **Check `.changeset/` first** for an existing entry that already covers your change. Do not create duplicate or overlapping changesets in the same PR.
2. Create `.changeset/<descriptive-name>.md`, where `<descriptive-name>` is a short, kebab-case slug describing the change (e.g. `typed-sse-body-accessor.md`).
3. Add YAML front matter listing each affected package and its bump type, followed by a concise summary. Use the package's real name (`opinionated-machine` for the framework package, `@opinionated-machine/<name>` for the adapters):

   ```md
   ---
   "opinionated-machine": minor
   "@opinionated-machine/sse-rooms-redis": patch
   ---

   One-line summary of what changed.
   ```

4. Commit the file with your PR.

Create **one changeset per logical change** (not per package): a single changeset may span multiple packages, and a PR with unrelated changes should have multiple changesets.

> The interactive `pnpm changeset` CLI is available as an optional alternative, but manually authored changesets are preferred so descriptions stay specific and file names readable.

> **Note:** If you add headers inside a changeset, use `####` or `#####` only. Shallower headers will break the final CHANGELOG and upstream tooling.

**Choose the correct bump type:**

- `patch`: bug fixes
- `minor`: new features, backwards-compatible
- `major`: breaking changes

**Writing a good description:**

- Focus on user-facing impact; skip implementation details
- Keep it to 1 to 3 sentences
- Use past tense for what you did ("Added support for X") and present tense for package behavior ("The processor now handles Y")

## Releases

Releases are triggered automatically when a PR with a changeset is merged to `main`.
Do not bump version numbers manually: versioning is handled by the release pipeline.
