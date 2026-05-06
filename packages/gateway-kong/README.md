# @opinionated-machine/gateway-kong

Generate a Kong (DB-less / declarative) config from your
[opinionated-machine](https://github.com/kibertoad/opinionated-machine) routes.
Annotate routes once with rate-limits / cache / JWT / etc., then run this
generator at build time and deploy the resulting `kong.yaml`.

```sh
npm install --save-dev @opinionated-machine/gateway-kong
```

`opinionated-machine` is a peer dependency.

## Use it

```ts
// bin/render-kong.ts
import { writeFileSync } from 'node:fs'
import { renderKongConfig } from '@opinionated-machine/gateway-kong'
import { buildContext } from '../src/diContext.ts'   // your DIContext factory

const ctx = await buildContext()
const manifest = ctx.buildGatewayManifest({ service: 'users-api' })

const { yaml, warnings } = renderKongConfig(manifest, {
  upstreams: {
    'users-service': { url: 'http://users:8081', retries: 2 },
  },
})

writeFileSync('kong.yaml', yaml)
if (warnings.length) console.warn('[kong]', warnings)
```

The output goes straight into Kong's DB-less mode (`KONG_DATABASE=off`,
`KONG_DECLARATIVE_CONFIG=/etc/kong/kong.yml`).

Routes are grouped into one Kong **service** per `metadata.upstream`. Paths
with `{param}` segments become regex paths with named captures —
`/users/{userId}` becomes `~/users/(?<userId>[^/]+)$`.

## How metadata maps to Kong

| Route metadata | Kong output |
| -------------- | ----------- |
| `upstream` | `services[].host`/`port`, resolved via `KongOptions.upstreams` |
| `timeouts.request` | service `read_timeout` (tightest among all routes for that upstream) |
| `match.headers` / `customHeaders` | route `headers` (exact / `~prefix` / `~regex`) |
| `rewrite.stripPrefix` | route `strip_path: true` |
| `rateLimit` | `rate-limiting` plugin on the route (bucket: `second`/`minute`/`hour`/`day`; `limit_by`) |
| `cache.ttl` | `proxy-cache` plugin on the route (`cache_ttl`, `request_method`, `vary_headers`) |
| `auth.jwt` | `jwt` plugin on the route (marker — see "What it doesn't do" below) |
| `cors` | promoted to a global `cors` plugin |
| `headers.request.{add,remove}` | `request-transformer` plugin on the route |
| `headers.response.{add,remove}` | `response-transformer` plugin on the route |
| `extensions.kong` | shallow-merged onto the route last |
| `extensions.kong_plugins` | array of extra plugins appended to the route |

Kong's plugin system is the natural fit for most of the universal metadata —
this generator covers more of it natively than the Envoy or KrakenD ones do.

## What it doesn't do

Reported as `warnings[]` on the result:

- `circuitBreaker` — no native equivalent in Kong CE; consider Kong Enterprise
  or a service-mesh layer.
- `traffic.weights` / `traffic.shadow` — not modelled here; configure Kong
  upstreams + targets manually if needed.
- **`auth.jwt` is a marker only.** Kong's JWT plugin reads keys from consumer
  credentials, not from a JWKS URI in declarative config. The generator emits
  the plugin so you can wire credentials separately (consumers + jwt_secrets).

## Verifying generated configs

CI boots Kong (DB-less) plus a stub upstream and drives traffic through the
generated config:

```sh
npm run test:acceptance
```

Requires Docker. Triggered automatically by the
[`gateway-acceptance`](../../.github/workflows/gateway-acceptance.yml) workflow
when this package or `lib/gateway/` changes.
