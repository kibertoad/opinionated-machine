---
"@opinionated-machine/sse-fallback": minor
---

`streamRefusal: 'poll-only'` keeps the reconciliation poll running when the SSE stream alone is refused with an unretryable status, instead of stopping the subscription on both channels.
