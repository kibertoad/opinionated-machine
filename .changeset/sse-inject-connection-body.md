---
"opinionated-machine": minor
---

Expose the response body on `SSEInjectConnection`: `getBody()` returns the raw body string and `json<T>()` parses it as JSON, mirroring Fastify's inject response. This lets tests using the untyped `SSEInjectClient` assert on JSON error bodies that an SSE route sends before streaming starts (auth failures, validation errors, unavailable integrations), which previously were unreachable.
