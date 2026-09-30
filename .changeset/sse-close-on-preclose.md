---
"opinionated-machine": patch
---

`DIContext.registerRoutes` now lets `app.close()` finish while SSE streams are open. Fastify closes its HTTP server in an `onClose` hook that runs before any the app registers, and the server waits for every open connection, so an open keepAlive stream held `app.close()` until the process was killed: no `onClose` hook registered after it ran, including the DI container dispose that lets message queue consumers leave their group.

For `buildApiRoute` routes, a `preClose` hook closes the keepAlive streams still open, while autoClose streams still being generated are left to finish. Once the server is closing, idle keep-alive connections are also closed as requests complete, since a response that finishes during shutdown otherwise keeps its socket open until `keepAliveTimeout`. No change is needed in the app.
