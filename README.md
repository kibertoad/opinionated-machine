# opinionated-machine

Monorepo for `opinionated-machine`, a very opinionated DI framework for fastify built on top of
awilix, and the adapter packages that plug into it.

Full framework documentation lives with the package it documents:
[packages/opinionated-machine/README.md](./packages/opinionated-machine/README.md).

## Packages

| Package | Description |
| --- | --- |
| [`opinionated-machine`](./packages/opinionated-machine) | DI, controllers, routes, SSE and dual-mode contracts for fastify |
| [`@opinionated-machine/sse-parser`](./packages/sse-parser) | Dependency-free SSE parser for incremental streams and complete response bodies |
| [`@opinionated-machine/sse-fallback`](./packages/sse-fallback) | Browser-safe SSE client core with transparent polling fallback |
| [`@opinionated-machine/sse-rooms-redis`](./packages/sse-rooms-redis) | Redis adapter for SSE rooms |
| [`@opinionated-machine/gateway-envoy`](./packages/gateway-envoy) | Envoy config generator for gateway manifests |
| [`@opinionated-machine/gateway-kong`](./packages/gateway-kong) | Kong (DB-less) config generator for gateway manifests |
| [`@opinionated-machine/gateway-krakend`](./packages/gateway-krakend) | KrakenD config generator for gateway manifests |

## Development

Tasks are orchestrated by [Turborepo](https://turborepo.dev), which reads the workspace graph from
`turbo.jsonc`:

```bash
pnpm install
pnpm run build:all   # build every package in dependency order
pnpm run lint:all    # biome + tsc in every package
pnpm run test:all    # every package's suite
```

Start with `build:all` on a fresh clone. The per-package `build`, `lint` and `test` scripts each do
one package's work and assume their workspace dependencies are already built, so `pnpm run build`
inside a package fails until the graph has been built once.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full task table, caching notes and the changeset
workflow.

## License

[MIT](./LICENSE)
