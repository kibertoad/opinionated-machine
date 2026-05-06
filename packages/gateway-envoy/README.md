# @opinionated-machine/gateway-envoy

Generate an Envoy v3 static config from your
[opinionated-machine](https://github.com/kibertoad/opinionated-machine) routes.
Annotate routes once with timeouts / retries / header rules / etc., then run
this generator at build time and deploy the resulting `envoy.yaml`.

```sh
npm install --save-dev @opinionated-machine/gateway-envoy
```

`opinionated-machine` is a peer dependency.

## Use it

```ts
// bin/render-envoy.ts
import { writeFileSync } from 'node:fs'
import { renderEnvoyConfig } from '@opinionated-machine/gateway-envoy'
import { buildContext } from '../src/diContext.ts'   // your DIContext factory

const ctx = await buildContext()
const manifest = ctx.buildGatewayManifest({ service: 'users-api' })

const { yaml, warnings } = renderEnvoyConfig(manifest, {
  listenPort: 8080,
  clusters: {
    'users-service': { hosts: ['users:8081'], connectTimeout: '1s' },
  },
})

writeFileSync('envoy.yaml', yaml)
if (warnings.length) console.warn('[envoy]', warnings)
```

```sh
$ tsx bin/render-envoy.ts && envoy --mode validate -c envoy.yaml
configuration 'envoy.yaml' OK
```

`renderEnvoyConfig(...)` also returns `json` (the same config as a JS object,
handy for tests and inspection).

## How metadata maps to Envoy

| Route metadata | Envoy output |
| -------------- | ------------ |
| `upstream` | route's `cluster`; deduped clusters under `static_resources.clusters` |
| `match.headers` / `customHeaders` | `route.match.headers[]` (`exact` / `prefix` / `safe_regex`) |
| `match.query` / `customQuery`     | `route.match.query_parameters[]` |
| `timeouts.request`     | `route.timeout` |
| `timeouts.connect`     | `cluster.connect_timeout` (set via `EnvoyClusterOptions.connectTimeout`) |
| `retry.attempts`       | `route.retry_policy.num_retries` |
| `retry.on`             | `route.retry_policy.retry_on` (CSV) |
| `retry.perTryTimeout`  | `route.retry_policy.per_try_timeout` |
| `rewrite.stripPrefix`  | `route.prefix_rewrite: '/'` |
| `headers.request.{add,remove}`   | `route.request_headers_to_{add,remove}` |
| `headers.response.{add,remove}`  | `route.response_headers_to_{add,remove}` |
| `extensions.envoy`     | shallow-merged onto the route last (escape hatch) |

## What it doesn't do

These metadata fields produce a `warnings[]` entry instead of being silently
dropped — they need an Envoy filter that this generator doesn't wire for you:

- `cache.ttl` — needs `envoy.filters.http.cache`
- `auth.jwt` — needs `envoy.filters.http.jwt_authn`
- `cors` — needs `envoy.filters.http.cors`
- `rateLimit` — needs `envoy.filters.http.local_ratelimit`
- `circuitBreaker` — applies at the cluster level

For any of these, configure the filter once in your Envoy listener and use
`extensions.envoy` on the route to attach the per-route typed-config block.

## Verifying generated configs

This package's CI runs an acceptance suite that boots a real Envoy container
plus a stub upstream and drives traffic through the generated config:

```sh
npm run test:acceptance
```

Requires Docker. Triggered automatically by the
[`gateway-acceptance`](../../.github/workflows/gateway-acceptance.yml) workflow
when this package or `lib/gateway/` changes.
