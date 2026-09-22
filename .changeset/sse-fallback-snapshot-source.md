---
"@opinionated-machine/sse-fallback": minor
---

BREAKING: `FallbackBindingConfig.snapshotSource` is now required. Declare `'endpoint'` when the snapshot is a route the server answers, `'synthesized'` when the transport answers it locally (the push-only pattern).

A synthesized snapshot switches the poll channel off instead of running hydration polls, the deadman and a degraded cadence that can only ever deliver nothing: the status machine drops `'polling'`, `nudge()` reconnects a silent stream, and `mode: 'poll-only'` or `streamRefusal: 'keep-polling'` alongside one throws at construction rather than producing a subscription that looks alive.
