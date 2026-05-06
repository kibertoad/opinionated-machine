# @opinionated-machine/gateway-krakend

KrakenD v3 declarative-config generator for
[opinionated-machine](https://github.com/kibertoad/opinionated-machine) gateway
manifests.

## Install

```sh
npm install @opinionated-machine/gateway-krakend
```

`opinionated-machine` is a peer dependency.

## Usage

```ts
import { writeFileSync } from 'node:fs'
import { renderKrakendConfig } from '@opinionated-machine/gateway-krakend'

const manifest = context.buildGatewayManifest({ service: 'users-api' })

const { json, warnings } = renderKrakendConfig(manifest, {
  port: 8080,
  upstreams: { 'users-service': 'http://users:8081' },
})

writeFileSync('krakend.json', JSON.stringify(json, null, 2))
console.warn(warnings)
```

KrakenD's `{var}` path syntax is native, so paths pass through unchanged.

## Field mappings

| `GatewayMetadata` field   | KrakenD mapping |
| ------------------------- | --------------- |
| `upstream`                | endpoint `backend[].host` (resolved via `KrakendOptions.upstreams`) |
| `timeouts.request`        | endpoint `backend[].extra_config["backend/http/client"].timeout` |
| `cache.ttl`               | endpoint `extra_config["qos/http-cache"].ttl` |
| `cache.vary`              | endpoint `extra_config["qos/http-cache"].vary` |
| `rateLimit`               | endpoint `extra_config["qos/ratelimit/router"]` (`max_rate`/`every`/`strategy`) |
| `circuitBreaker`          | endpoint `extra_config["qos/circuit-breaker"]` |
| `auth.jwt`                | endpoint `extra_config["auth/validator"]` (issuer / audience / jwk_url) |
| `cors`                    | promoted to root-level `extra_config["security/cors"]` (KrakenD applies CORS globally) |
| `rewrite.stripPrefix`     | endpoint `backend[].url_pattern` rewriting |
| `extensions.krakend`      | shallow-merged into endpoint `extra_config` last (escape hatch) |

## Limitations (v1)

Reported as `warnings[]` on the result:

- `headers.request.add` — KrakenD doesn't natively express request-header
  injection per endpoint; use `extensions.krakend` or a Lua plugin.
- `match.host` — host routing is typically handled at the listener level.
- `retry` — KrakenD's retry knobs live under `backend/http/client`; v1 emits
  attempts on a best-effort basis.

## Acceptance tests

This package includes a Docker-based acceptance suite that boots a real
KrakenD container plus a stub upstream:

```sh
npm run test:acceptance
```

Triggered automatically in CI by the
[`gateway-acceptance`](../../.github/workflows/gateway-acceptance.yml) workflow
when this package or `lib/gateway/` changes.
