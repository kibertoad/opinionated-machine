# @opinionated-machine/gateway-krakend

Generate a KrakenD v3 declarative config from your
[opinionated-machine](https://github.com/kibertoad/opinionated-machine) routes.
Annotate routes once with timeouts / cache / rate-limits / etc., then run this
generator at build time and deploy the resulting `krakend.json`.

```sh
npm install --save-dev @opinionated-machine/gateway-krakend
```

`opinionated-machine` is a peer dependency.

## Use it

```ts
// bin/render-krakend.ts
import { writeFileSync } from 'node:fs'
import { renderKrakendConfig } from '@opinionated-machine/gateway-krakend'
import { buildContext } from '../src/diContext.ts'   // your DIContext factory

const ctx = await buildContext()
const manifest = ctx.buildGatewayManifest({ service: 'users-api' })

const { json, warnings } = renderKrakendConfig(manifest, {
  port: 8080,
  upstreams: { 'users-service': 'http://users:8081' },
})

writeFileSync('krakend.json', JSON.stringify(json, null, 2))
if (warnings.length) console.warn('[krakend]', warnings)
```

```sh
$ tsx bin/render-krakend.ts && krakend check -c krakend.json
Syntax OK!
```

KrakenD's native `{var}` path syntax matches the manifest's path format, so
paths pass through unchanged.

## How metadata maps to KrakenD

| Route metadata | KrakenD output |
| -------------- | -------------- |
| `upstream` | endpoint `backend[].host` (resolved via `KrakendOptions.upstreams`) |
| `timeouts.request` | endpoint `backend[].extra_config["backend/http/client"].timeout` |
| `cache.ttl` / `cache.vary` | endpoint `extra_config["qos/http-cache"]` |
| `rateLimit` | endpoint `extra_config["qos/ratelimit/router"]` (`max_rate`, `every`, `strategy`) |
| `circuitBreaker` | endpoint `extra_config["qos/circuit-breaker"]` |
| `auth.jwt` | endpoint `extra_config["auth/validator"]` (issuer / audience / jwk_url) |
| `cors` | promoted to root-level `extra_config["security/cors"]` (KrakenD applies CORS globally) |
| `rewrite.stripPrefix` | endpoint `backend[].url_pattern` rewriting |
| `extensions.krakend` | deep-merged into endpoint `extra_config` last (escape hatch) |

KrakenD shines when you need caching: this generator wires `qos/http-cache`
out of the box from `cache.ttl`, whereas the Envoy generator leaves cache
configuration to you.

## What it doesn't do

These metadata fields produce a `warnings[]` entry rather than being silently
dropped:

- `headers.request.add` — KrakenD has no first-class per-endpoint header
  injection; use `extensions.krakend` or a Lua plugin.
- `match.host` — host routing typically lives at the listener level.
- `retry` — KrakenD's retry knobs sit under `backend/http/client`; emit them
  with `extensions.krakend` for now.

## Verifying generated configs

CI boots a real KrakenD container plus a stub upstream and drives traffic
through the generated config:

```sh
npm run test:acceptance
```

Requires Docker. Triggered automatically by the
[`gateway-acceptance`](../../.github/workflows/gateway-acceptance.yml) workflow
when this package or `lib/gateway/` changes.
