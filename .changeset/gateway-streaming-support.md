---
"opinionated-machine": minor
"@opinionated-machine/gateway-envoy": minor
"@opinionated-machine/gateway-kong": minor
"@opinionated-machine/gateway-krakend": minor
---

Mark streaming routes in the gateway manifest and map `timeouts.idle` in all generators.

- Routes built from SSE/dual-mode contracts are stamped with a streaming mode (non-enumerable `Symbol.for('opinionated-machine.route.streaming')`), and the manifest gains an optional `streaming: 'sse' | 'dual'` field. Legacy `AbstractSSEController`/`AbstractDualModeController` routes can be included via the new `buildGatewayManifest({ includeStreamingControllers: true })` opt-in.
- Envoy: `timeouts.idle` maps to route-level `idle_timeout` (previously silently ignored); streaming routes default to `timeout: 0s` and `idle_timeout: 0s` so Envoy's defaults (15s route timeout, 5m stream idle timeout) no longer reset SSE streams; new `EnvoyOptions.streamIdleTimeout` configures the listener-wide HCM value; declaring `timeouts.request` on a streaming route now warns (it bounds total stream lifetime).
- Kong: `timeouts.idle` participates in the loosest-wins service `read_timeout`; streaming routes emit `response_buffering: false` (Kong ≥ 2.3); streaming routes without `timeouts.idle` warn that heartbeats must beat the effective `read_timeout`.
- KrakenD: the endpoint `timeout` uses the looser of `timeouts.request`/`timeouts.idle`; streaming routes with neither warn about KrakenD's 2s default endpoint timeout.
