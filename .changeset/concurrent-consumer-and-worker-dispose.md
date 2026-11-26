---
"opinionated-machine": major
---

`asMessageQueueHandlerClass` and `asEnqueuedJobWorkerClass` now close consumers and dispose workers concurrently with the other disposes of their `asyncDisposePriority`, using awilix-manager's `concurrent` dispose option. One slow consumer or worker no longer delays the rest on shutdown. A concurrent dispose runs alongside every other dispose of the same priority, including the sequential ones sorted before it, so a dependency that has to be disposed after a consumer or worker needs a higher `asyncDisposePriority`. `asPgBossProcessorClass` moves from `asyncDisposePriority` 10 to 12, so pg-boss processors still stop after message queue consumers have closed. Pass `asyncDispose: 'close'` (consumers) or `asyncDispose: 'dispose'` (workers) in `opts` to dispose one without the flag.

`DIContext` options gain `maxInitConcurrency`, `maxDisposeConcurrency` and `onDisposeError`, passed to the `AwilixManager` that `DIContext` builds, so the concurrent starts and closes of consumers and workers can be capped and a failed dispose no longer has to skip every later priority. All three are unset by default, which keeps the awilix-manager defaults: no concurrency cap, and the first failed dispose stops the remaining ones.

The `awilix-manager` peer dependency is raised to `>=7.2.0`: versions before 7.2.0 do not understand an object `asyncDispose` and fail on shutdown with `resolvedValue[asyncDispose] is not a function`. The same floor applies to the copy that runs the disposes when an `AwilixManager` built by `@fastify/awilix` is passed to `DIContext`, since `@fastify/awilix` depends on `awilix-manager` directly.
