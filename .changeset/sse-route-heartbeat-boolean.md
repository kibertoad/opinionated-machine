---
"opinionated-machine": major
---

Replace the silently-ignored per-route `heartbeatInterval` SSE option with `heartbeat: boolean`.

`@fastify/sse` has no per-route `heartbeatInterval`: the route-level knob is `heartbeat`, a boolean
that can only turn the heartbeat off, while the interval is a plugin-registration option shared by
all routes. The route builder was copying `heartbeatInterval` onto the route's `sse` option, where
the plugin never read it — so `buildHandler(contract, handlers, { heartbeatInterval: 5000 })`
type-checked, ran, and did nothing, and there was no way to disable the heartbeat for a single route.

Breaking changes:

- `FastifySSERouteOptions` / `FastifyDualModeRouteOptions`: `heartbeatInterval?: number` is replaced
  by `heartbeat?: boolean`. Set `heartbeat: false` to suppress heartbeat comments on a route.
- `RegisterSSERoutesOptions` / `RegisterDualModeRoutesOptions`: `heartbeatInterval?: number` is
  likewise replaced by `heartbeat?: boolean`. These options are applied to individual routes, not to
  plugin registration, so they could never carry an interval either.

Configure the interval where it actually works, once for all routes:
`app.register(fastifySSE, { heartbeatInterval: 30000 })`.

Also fixes the registration-level `heartbeat` / `serializer` defaults from `registerSSERoutes()` and
`registerDualModeRoutes()`, which were written to `config.sse` — a location `@fastify/sse` never
reads — and are now merged into the top-level `sse` route option, with per-route values taking
precedence.
