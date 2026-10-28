---
"opinionated-machine": major
---

`asMessageQueueHandlerClass` and `asEnqueuedJobWorkerClass` now close consumers and dispose workers concurrently with the other disposes of their `asyncDisposePriority`, using awilix-manager's `concurrent` dispose option. One slow consumer or worker no longer delays the rest on shutdown. A concurrent dispose overlaps every dispose of the same priority that comes after it in key order, so a dependency that has to be disposed after a consumer or worker needs a higher `asyncDisposePriority`. Pass `asyncDispose: 'close'` (consumers) or `asyncDispose: 'dispose'` (workers) in `opts` to dispose one without the flag.

The `awilix-manager` peer dependency is raised to `>=7.2.0`: versions before 7.2.0 do not understand an object `asyncDispose` and fail on shutdown with `resolvedValue[asyncDispose] is not a function`. The same floor applies to the copy that runs the disposes when an `AwilixManager` built by `@fastify/awilix` is passed to `DIContext`, since `@fastify/awilix` depends on `awilix-manager` directly.
