---
"@opinionated-machine/sse-fallback": minor
---

`streamRefusal` decides what a refused SSE connect does, defaulting to `'auto'`: keep the reconciliation poll running when the snapshot is a real endpoint, stop the subscription when it is synthesized and polling on would deliver nothing. `subscription.streamAbandoned` and `diagnostics.onStreamRefused` report a stream given up for good.
