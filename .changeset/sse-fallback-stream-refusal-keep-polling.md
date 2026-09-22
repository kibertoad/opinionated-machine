---
"@opinionated-machine/sse-fallback": minor
---

BREAKING: a stream connect refused with a status in `unretryableStatuses` no longer stops an endpoint-backed subscription by default. The new `streamRefusal` policy defaults to `'auto'`: with `snapshotSource: 'endpoint'` the stream is given up and the reconciliation poll carries on at the degraded cadence (no `onStop`, status `'polling'`), and with `'synthesized'` the subscription stops as before. Set `streamRefusal: 'stop'` to keep the 0.1 behaviour, e.g. where a `'no access'` UI hangs off `onStop({ reason: 'unretryable-status', channel: 'stream' })`. `subscription.streamAbandoned` and `diagnostics.onStreamRefused` report a stream given up for good.
