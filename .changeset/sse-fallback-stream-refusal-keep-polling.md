---
"@opinionated-machine/sse-fallback": minor
---

`streamRefusal: 'keep-polling'` keeps the reconciliation poll running when the SSE stream alone is refused with an unretryable status, instead of stopping the subscription on both channels. `subscription.streamAbandoned` and `diagnostics.onStreamRefused` report the stream that was given up.
