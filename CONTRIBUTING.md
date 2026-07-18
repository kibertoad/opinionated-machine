# Contributing to opinionated-machine

## Rules

There are a few basic ground-rules for contributors:

1. **Non-main branches** ought to be used for ongoing work.
2. Contributors should attempt to adhere to the prevailing code-style.
3. Before submitting a PR for a major new feature, or introducing a significant change, please open an issue to discuss the proposal with maintainers.

## Changesets

This repo uses [Changesets](https://github.com/changesets/changesets) to automate versioning and releases.

If your PR affects anything used by consumers (API, types, runtime behavior, or usage-facing docs), add a changeset by **creating the file manually**.

1. **Check `.changeset/` first** for an existing entry that already covers your change — do not create duplicate or overlapping changesets in the same PR.
2. Create `.changeset/<descriptive-name>.md`, where `<descriptive-name>` is a short, kebab-case slug describing the change (e.g. `typed-sse-body-accessor.md`).
3. Add YAML front matter listing each affected package and its bump type, followed by a concise summary. Use the package's real name (`opinionated-machine` for the root, `@opinionated-machine/<name>` for the workspace packages):

   ```md
   ---
   "opinionated-machine": minor
   "@opinionated-machine/sse-rooms-redis": patch
   ---

   One-line summary of what changed.
   ```

4. Commit the file with your PR.

Create **one changeset per logical change** (not per package) — a single changeset may span multiple packages, and a PR with unrelated changes should have multiple changesets.

> The interactive `pnpm changeset` CLI is available as an optional alternative, but manually authored changesets are preferred so descriptions stay specific and file names readable.

> **Note:** If you add headers inside a changeset, use `####` or `#####` only. Shallower headers will break the final CHANGELOG and upstream tooling.

**Choose the correct bump type:**

- `patch` — bug fixes
- `minor` — new features, backwards-compatible
- `major` — breaking changes

**Writing a good description:**

- Focus on user-facing impact; skip implementation details
- Keep it to 1–3 sentences
- Use past tense for what you did ("Added support for X") and present tense for package behavior ("The processor now handles Y")

## Releases

Releases are triggered automatically when a PR with a changeset is merged to `main`.
Do not bump version numbers manually — versioning is handled by the release pipeline.
