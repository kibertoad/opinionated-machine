---
"opinionated-machine": major
---

`asMessageQueueHandlerClass` and `asEnqueuedJobWorkerClass` now start consumers and workers concurrently with the other inits of their `asyncInitPriority`, using awilix-manager's `concurrent` option. The `awilix-manager` peer dependency is raised to `>=7.1.0`, because older versions ignore the flag or, before 6.3.0, skip object-form `asyncInit` entirely. Pass `asyncInit: 'start'` in `opts` to keep a sequential start.
