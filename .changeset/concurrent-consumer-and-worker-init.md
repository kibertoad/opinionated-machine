---
"opinionated-machine": major
---

`asMessageQueueHandlerClass` and `asEnqueuedJobWorkerClass` now start consumers and workers concurrently with the other inits of their `asyncInitPriority`, using awilix-manager's `concurrent` option. A concurrent init overlaps every init of the same priority that comes after it in key order, so a dependency that has to wait for a consumer or worker (for example a publisher that locates the queue a consumer creates) needs a higher `asyncInitPriority`. Pass `asyncInit: 'start'` in `opts` to start a consumer or worker without the flag.

The `awilix-manager` peer dependency is raised to `>=7.1.0`: versions 6.3.0 to 7.0.x ignore the flag and start sequentially, and versions before 6.3.0 fail at startup with `Method [object Object] for asyncInit does not exist`. The same floor applies to the copy that runs the inits when an `AwilixManager` built by `@fastify/awilix` is passed to `DIContext`, since `@fastify/awilix` depends on `awilix-manager` directly.
