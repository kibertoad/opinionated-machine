# @opinionated-machine/gateway-envoy

Envoy v3 static-config generator for [opinionated-machine](https://github.com/kibertoad/opinionated-machine)
gateway manifests.

## Install

```sh
npm install @opinionated-machine/gateway-envoy
```

`opinionated-machine` is a peer dependency.

## Usage

```ts
import { writeFileSync } from 'node:fs'
import { renderEnvoyConfig } from '@opinionated-machine/gateway-envoy'

const manifest = context.buildGatewayManifest({ service: 'users-api' })

const { yaml, json, warnings } = renderEnvoyConfig(manifest, {
  listenPort: 8080,
  clusters: {
    'users-service': { hosts: ['users:8081'], connectTimeout: '1s' },
  },
})

writeFileSync('envoy.yaml', yaml)
console.warn(warnings)            // metadata fields Envoy v1 doesn't natively support
```

The generator is a pure function — same manifest in, same config out — with
zero coupling to Fastify, your DI container, or contract definitions.

## Field mappings

| `GatewayMetadata` field | Envoy mapping |
| ----------------------- | ------------- |
| `upstream`              | `cluster` reference; deduped clusters in `static_resources.clusters` |
| `match.headers` / `customHeaders` | `match.headers[]` with `string_match` (exact/prefix/regex) |
| `match.query` / `customQuery`     | `match.query_parameters[]` |
| `timeouts.request`      | `route.timeout` |
| `timeouts.connect`      | `cluster.connect_timeout` (via `EnvoyClusterOptions.connectTimeout`) |
| `retry.attempts`        | `route.retry_policy.num_retries` |
| `retry.on`              | `route.retry_policy.retry_on` (CSV) |
| `retry.perTryTimeout`   | `route.retry_policy.per_try_timeout` |
| `rewrite.stripPrefix`   | `route.prefix_rewrite: '/'` |
| `headers.request.add`   | `route.request_headers_to_add` |
| `headers.request.remove`| `route.request_headers_to_remove` |
| `headers.response.add`  | `route.response_headers_to_add` |
| `headers.response.remove` | `route.response_headers_to_remove` |
| `extensions.envoy`      | shallow-merged onto the route last (escape hatch) |

## Limitations (v1)

The following universal fields are **not** mapped to Envoy in v1 — they appear
as `warnings[]` entries on the result so they aren't silently dropped:

- `cache.ttl` — needs `envoy.filters.http.cache` wired separately
- `circuitBreaker` — applies at the cluster level; v1 emits routes only
- `auth.jwt` — needs `envoy.filters.http.jwt_authn` filter + provider on the listener
- `cors` — needs `envoy.filters.http.cors` filter
- `rateLimit` — needs `envoy.filters.http.local_ratelimit` typed_per_filter_config

Use `extensions.envoy` on a route for any of these.

## Acceptance tests

This package includes a Docker-based acceptance suite that boots a real Envoy
container plus a stub upstream and drives traffic through the generated config:

```sh
npm run test:acceptance
```

Triggered automatically in CI by the
[`gateway-acceptance`](../../.github/workflows/gateway-acceptance.yml) workflow
when this package or `lib/gateway/` changes. Requires Docker locally.
