# @opinionated-machine/gateway-kong

Kong (DB-less / declarative) config generator for
[opinionated-machine](https://github.com/kibertoad/opinionated-machine) gateway
manifests.

## Install

```sh
npm install @opinionated-machine/gateway-kong
```

`opinionated-machine` is a peer dependency.

## Usage

```ts
import { writeFileSync } from 'node:fs'
import { renderKongConfig } from '@opinionated-machine/gateway-kong'

const manifest = context.buildGatewayManifest({ service: 'users-api' })

const { yaml, json, warnings } = renderKongConfig(manifest, {
  upstreams: {
    'users-service': { url: 'http://users:8081', retries: 2 },
  },
})

writeFileSync('kong.yaml', yaml)
console.warn(warnings)
```

The output is suitable for Kong's DB-less mode (`KONG_DATABASE=off`,
`KONG_DECLARATIVE_CONFIG=/etc/kong/kong.yml`).

Routes are grouped into one Kong **service** per `metadata.upstream`. Paths
with `{param}` segments become regex paths with named captures (`~/users/(?<userId>[^/]+)$`).

## Field mappings

| `GatewayMetadata` field    | Kong mapping |
| -------------------------- | ------------ |
| `upstream`                 | `services[].host`/`port` (resolved via `KongOptions.upstreams`) |
| `timeouts.request`         | service `read_timeout` (tightest among all routes for that upstream) |
| `match.headers` / `customHeaders` | route `headers` (exact / `~prefix` / `~regex`) |
| `rewrite.stripPrefix`      | route `strip_path: true` |
| `rateLimit`                | `rate-limiting` plugin on the route (`second`/`minute`/`hour`/`day` bucket; `limit_by`) |
| `cache.ttl`                | `proxy-cache` plugin on the route (`cache_ttl`, `request_method`, `vary_headers`) |
| `auth.jwt`                 | `jwt` plugin on the route (marker — wire credentials separately) |
| `cors`                     | promoted to a global `cors` plugin (Kong applies it at the global / service / route level) |
| `headers.request.add/remove`  | `request-transformer` plugin on the route |
| `headers.response.add/remove` | `response-transformer` plugin on the route |
| `extensions.kong`          | shallow-merged onto the route last |
| `extensions.kong_plugins`  | array of extra plugins appended to the route |

## Limitations (v1)

Reported as `warnings[]` on the result:

- `circuitBreaker` — no native equivalent in Kong CE; consider Kong Enterprise
  or a service-mesh layer.
- `traffic.weights` / `traffic.shadow` — not modelled in v1; configure Kong
  upstreams + targets manually if needed.
- `auth.jwt` is a plugin **marker**: Kong's JWT plugin looks up keys from
  consumer credentials, not from a JWKS URI in declarative config. Wire
  consumers separately.

## Acceptance tests

This package includes a Docker-based acceptance suite that boots Kong (DB-less)
plus a stub upstream:

```sh
npm run test:acceptance
```

Triggered automatically in CI by the
[`gateway-acceptance`](../../.github/workflows/gateway-acceptance.yml) workflow
when this package or `lib/gateway/` changes.
