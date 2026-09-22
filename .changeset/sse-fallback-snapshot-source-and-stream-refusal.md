---
"@opinionated-machine/sse-fallback": minor
---

BREAKING: `FallbackBindingConfig.snapshotSource` is now required. Declare `'endpoint'` when the snapshot is a route the server answers, `'synthesized'` when the transport answers it locally (the push-only pattern).

A synthesized snapshot switches the poll channel off instead of running hydration polls, the deadman and a degraded cadence that can only ever deliver nothing: the status machine drops `'polling'`, `nudge()` skips the rest of a pending reconnect backoff, and `mode: 'poll-only'` or `streamRefusal: 'keep-polling'` alongside one throws at construction rather than producing a subscription that looks alive. `defineFallbackBinding` likewise rejects a `state` layer beside a synthesized snapshot (nothing would ever initialize it) and any `snapshotSource` other than `'endpoint'` or `'synthesized'`.
