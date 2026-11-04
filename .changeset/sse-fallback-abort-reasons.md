---
"@opinionated-machine/sse-fallback": patch
---

The connect timeout aborts the stream with a `TimeoutError` that names the limit, for example "SSE connect timed out after 15000 ms", instead of an abort with no reason.
