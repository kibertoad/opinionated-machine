---
"opinionated-machine": minor
---

Type `SSEConnectOptions.method` as the new exported `SSEInjectMethod`, derived from Fastify's own inject options instead of a hand-listed `'GET' | 'POST' | 'PUT' | 'PATCH'` union. `SSEInjectClient.connectWithBody()` now accepts every method `inject()` accepts (including `DELETE`, `HEAD`, `OPTIONS` and the lowercase spellings), and consumers can import the union instead of redeclaring it.
