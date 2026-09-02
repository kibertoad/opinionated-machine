---
"@opinionated-machine/sse-fallback": minor
---

Initial release: browser-safe client core for SSE with a transparent polling fallback, built on `@opinionated-machine/sse-parser` and nothing else.

- `defineFallbackBinding(contract, config)` declares the reconciliation (snapshot→events mapping, version extraction, terminal events, optional state reducer) on a dual-mode contract; `bindFallbackContracts` binds two separate contracts; `fromLegacyDualModeContract` adapts legacy `buildSseContract` contracts.
- `createResilientSubscription(binding, { transport, params })` runs the client state machine: SSE as the low-latency channel, deadman-gated polls as the correctness backbone, a version gate for exactly-once-per-version delivery across both channels, subscribe-first hydration, byte-level stale-connection detection, `Last-Event-ID` reconnects, and degradation to pure polling with background SSE recovery.
- Transport-agnostic (`FallbackTransport` seam) with a scripted `TestTransport` for deterministic fake-timer tests.
