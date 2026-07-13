## Changesets

- Every PR that changes published package code needs at least ONE changeset
- Create one changeset per logical change (not per package)
- A single changeset may include multiple packages
- If a PR contains unrelated changes, use multiple changesets
- Create manually: add `.changeset/<descriptive-name>.md` with YAML front matter listing `"<package-name>": patch|minor|major` and a concise summary (e.g. `opinionated-machine`, `@opinionated-machine/gateway-envoy`)
- Check `.changeset/` before creating — do NOT create duplicate or overlapping changesets in the same PR
- Changeset summaries should be specific ("add drag-and-drop reordering to filter list" not "update filter list")

Example:

```md
---
"opinionated-machine": minor
"@opinionated-machine/gateway-envoy": patch
---

One-line summary of what changed.
```
