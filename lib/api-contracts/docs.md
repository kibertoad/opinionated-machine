# ApiContract Controllers

The `lib/api-contracts/` module provides `AbstractApiController` and `buildApiRoute` — a lightweight way to register typed API routes (sync JSON, SSE-only, and dual-mode) using contracts from `@lokalise/api-contracts`.

## Table of Contents

- [Overview](#overview)
- [Defining Contracts](#defining-contracts)
- [Response Modes](#response-modes)
- [Creating a Controller](#creating-a-controller)
- [Registering with DI](#registering-with-di)
- [Route Options](#route-options)
- [Testing](#testing)

## Overview

| Feature | Old API | New API |
|---------|---------|---------|
| Sync JSON routes | `AbstractController` + `asControllerClass` | `AbstractApiController` + `asApiControllerClass` |
| SSE-only routes | `AbstractSSEController` + `asSSEControllerClass` | `AbstractApiController` + `asApiControllerClass` |
| Dual-mode routes | `AbstractDualModeController` + `asDualModeControllerClass` | `AbstractApiController` + `asApiControllerClass` |
| Mixed route types | Three separate controllers | One controller for all modes |
| Contract format | `buildSseContract` / `buildGetApiContract` etc. | `defineApiContract` from `@lokalise/api-contracts` |

The response mode is **inferred automatically** from the contract's `responsesByStatusCode` shape — no separate contract builder per mode.

## Defining Contracts

Use `defineApiContract` from `@lokalise/api-contracts`. The response mode is determined by the values in `responsesByStatusCode`:

- **Non-SSE** — all success responses are plain Zod schemas, `noBodyResponse()`, or content maps without an SSE media type
- **SSE-only** — all success responses are content maps whose only media type is `sseBody(...)`
- **Dual** — success responses are content maps declaring both `sseBody(...)` and a non-SSE media type

```ts
import { defineApiContract, noBodyResponse, sseBody } from '@lokalise/api-contracts'
import { z } from 'zod/v4'

// Non-SSE (sync JSON)
const getUserContract = defineApiContract({
  method: 'get',
  summary: 'Get user',
  pathResolver: (p: { userId: string }) => `/users/${p.userId}`,
  requestPathParamsSchema: z.object({ userId: z.string() }),
  responsesByStatusCode: {
    200: z.object({ id: z.string(), name: z.string() }),
  },
})

// SSE-only
const streamUpdatesContract = defineApiContract({
  method: 'get',
  summary: 'Stream updates',
  pathResolver: () => '/updates/stream',
  responsesByStatusCode: {
    200: {
      content: {
        'text/event-stream': sseBody({
          update: z.object({ value: z.number() }),
          done: z.object({ total: z.number() }),
        }),
      },
    },
  },
})

// Dual-mode (branches on Accept header)
const chatContract = defineApiContract({
  method: 'post',
  summary: 'Chat',
  pathResolver: () => '/chat',
  requestBodySchema: z.object({ message: z.string() }),
  responsesByStatusCode: {
    200: {
      content: {
        'application/json': z.object({ reply: z.string() }),
        'text/event-stream': sseBody({
          chunk: z.object({ delta: z.string() }),
          done: z.object({}),
        }),
      },
    },
  },
})

// No-body response
const deleteUserContract = defineApiContract({
  method: 'delete',
  summary: 'Delete user',
  pathResolver: (p: { userId: string }) => `/users/${p.userId}`,
  requestPathParamsSchema: z.object({ userId: z.string() }),
  responsesByStatusCode: { 204: noBodyResponse() },
})
```

> **Note:** prefer `sseBody(...)` content maps over the `sseResponse(...)` helper — `sseResponse` erases the event schema types, so handlers lose the typed `session.send(...)` inference.

## Response Modes

`buildApiRoute` infers the correct handler shape from the contract at compile time:

| Mode | Contract shape | Handler type |
|------|---------------|--------------|
| **non-sse** | All success responses are plain schemas / `noBodyResponse()` | `(request, reply) => { status, body }` |
| **sse** | All success responses are `sseBody(...)`-only content maps | `(request, sse) => void` |
| **dual** | Mix of SSE and non-SSE success responses | Object `{ nonSse, sse }` |

TypeScript enforces the correct shape — passing `{ nonSse, sse }` to a non-dual contract is a compile error.

## Creating a Controller

Extend `AbstractApiController` with a `static contracts` object and a `routes` object built with `buildApiRoute`. The generic ensures every contract has a matching named route:

```ts
import {
  AbstractApiController,
  buildApiRoute,
} from 'opinionated-machine'

class UserController extends AbstractApiController<typeof UserController.contracts> {
  static contracts = {
    getUser: getUserContract,
    deleteUser: deleteUserContract,
    streamUpdates: streamUpdatesContract,
    chat: chatContract,
  } as const

  private readonly userService: UserService
  private readonly aiService: AIService

  constructor(deps: { userService: UserService; aiService: AIService }) {
    this.userService = deps.userService
    this.aiService = deps.aiService
  }

  readonly routes = {
    // Non-SSE: return { status, body }
    getUser: buildApiRoute(UserController.contracts.getUser, async (request) => ({
      status: 200,
      body: await this.userService.findById(request.params.userId),
    })),

    // Non-SSE no-body response
    deleteUser: buildApiRoute(UserController.contracts.deleteUser, async (request) => {
      await this.userService.delete(request.params.userId)
      return { status: 204, body: null }
    }),

    // SSE-only: second param is the SSE context
    streamUpdates: buildApiRoute(UserController.contracts.streamUpdates, async (_request, sse) => {
      sse.start('keepAlive')
    }),

    // Dual-mode: { nonSse, sse } object
    chat: buildApiRoute(UserController.contracts.chat, {
      nonSse: async (request) => {
        const result = await this.aiService.complete(request.body.message)
        return { status: 200, body: { reply: result.text } }
      },
      sse: async (request, sse) => {
        const session = sse.start('autoClose')
        for await (const chunk of this.aiService.stream(request.body.message)) {
          await session.send('chunk', { delta: chunk.text })
        }
        await session.send('done', {})
      },
    }),
  }
}
```

**Handler signatures:**

| Mode | Parameters | Return value |
|------|-----------|--------------|
| `non-sse` | `(request, reply: SyncModeReply)` | `{ status, body }` — status code + body, both validated against the contract |
| `sse` | `(request, sse: SSEContext)` | `void` |
| `dual.nonSse` | `(request, reply: SyncModeReply)` | `{ status, body }` |
| `dual.sse` | `(request, sse: SSEContext)` | `void` |

> **Note:** Non-SSE handlers must always return `{ status, body }`. The `status` is the HTTP status code to send; `body` is validated against the schema for that specific status code in the contract. TypeScript enforces the correct body shape per status code. Use `reply.header()` to set response headers when needed.

### SSE context methods

The `sse` parameter in SSE and dual-mode handlers:

| Method | Description |
|--------|-------------|
| `sse.start(mode)` | Begin streaming. Returns an `SSESession`. `mode` is `'keepAlive'` or `'autoClose'` |
| `sse.respond(code, body)` | Send an HTTP response without streaming (early return, e.g., 404) |

`autoClose` closes the connection when the handler returns. `keepAlive` keeps it open until explicitly closed.

### SSE session methods

The `session` returned by `sse.start(mode)`:

| Method | Description |
|--------|-------------|
| `session.send(event, data)` | Send a typed event (validated against contract schema) |
| `session.isConnected()` | Whether the client is still connected |
| `session.sendStream(iterable)` | Stream messages from an `AsyncIterable` |
| `session.getStream()` | Raw `WritableStream` for advanced use |

## Registering with DI

Use `asApiControllerClass` inside `resolveControllers()`:

```ts
import { asApiControllerClass } from 'opinionated-machine'

export class UserModule extends AbstractModule {
  resolveControllers() {
    return {
      userController: asApiControllerClass(UserController),
    }
  }
}
```

`asApiControllerClass` wraps the class in an awilix `asFunction` singleton resolver tagged with `isApiController: true`, so `DIContext` picks up its `routes` object automatically during `registerRoutes()`.

## Route Options

Pass options as the third argument to `buildApiRoute`:

```ts
buildApiRoute(contract, handler, {
  // Run before the handler — for auth/authorization
  preHandler: async (request, reply) => {
    if (!request.headers.authorization) {
      reply.code(401).send({ error: 'Unauthorized' })
    }
  },

  // SSE connection lifecycle hooks (ignored for non-SSE routes)
  onConnect: (session) => console.log('connected:', session.id),
  onClose: (session, reason) => console.log(`closed (${reason}):`, session.id),
  onReconnect: async (session, lastEventId) => this.getEventsSince(lastEventId),

  // Custom SSE serializer
  serializer: (data) => JSON.stringify(data),

  // Heartbeat keep-alive interval in ms
  heartbeatInterval: 30_000,

  // Default mode for dual-mode routes when Accept header is absent
  defaultMode: 'sse', // default: 'json'

  // Map contract metadata to Fastify route options
  contractMetadataToRouteMapper: (metadata) => ({
    config: { rateLimit: metadata.rateLimit },
    onRequest: metadata.requiresAuth ? authHook : undefined,
  }),
})
```

**Available options:**

| Option | Description |
|--------|-------------|
| `preHandler` | Fastify pre-handler hook (auth, rate limiting, etc.) |
| `onConnect` | Called after SSE session is established |
| `onClose` | Called when SSE session closes. `reason` is `'server'` or `'client'` |
| `onReconnect` | Handle `Last-Event-ID` reconnection; return events to replay |
| `serializer` | Custom serializer for SSE event data |
| `heartbeatInterval` | Interval in ms for SSE keep-alive heartbeats |
| `defaultMode` | Default response mode for dual-mode routes (`'json'` or `'sse'`). Default: `'json'` |
| `contractMetadataToRouteMapper` | Map contract metadata to Fastify `RouteOptions` fields |

Any other [Fastify `RouteOptions`](https://fastify.dev/docs/latest/Reference/Routes/) fields (`bodyLimit`, `onRequest`, `config`, etc.) can also be passed and are forwarded directly to Fastify.

## Testing

### Testing non-SSE routes

Use Fastify's `app.inject()` as normal. The status code comes from the `status` field of the returned `{ status, body }` object:

```ts
const response = await app.inject({
  method: 'GET',
  url: '/users/123',
})
expect(response.statusCode).toBe(200)
expect(JSON.parse(response.body)).toEqual({ id: '123', name: 'Alice' })
```

With multiple status codes:

```ts
// Handler returns { status: 404, body: { error: 'Not found' } } when user is missing
const response = await app.inject({ method: 'GET', url: '/users/missing' })
expect(response.statusCode).toBe(404)
expect(JSON.parse(response.body)).toEqual({ error: 'Not found' })
```

### Testing SSE-only routes (autoClose)

Use `SSEInjectClient` — no real HTTP server needed:

```ts
import { SSEInjectClient } from 'opinionated-machine'

const client = new SSEInjectClient(app)
const conn = await client.connect('/updates/stream')

expect(conn.getStatusCode()).toBe(200)
const events = conn.getReceivedEvents()
expect(events.filter(e => e.event === 'done')).toHaveLength(1)
```

### Testing SSE-only routes (keepAlive)

Use `SSEHttpClient` with `awaitServerConnection` to reliably send events after the connection is registered:

```ts
import { SSEHttpClient, SSETestServer } from 'opinionated-machine'

const server = await SSETestServer.start(app)

const client = await SSEHttpClient.connect(
  server.baseUrl,
  '/updates/stream',
)

client.close()
await server.stop()
```

### Testing dual-mode routes

```ts
// Sync mode
const response = await app.inject({
  method: 'POST',
  url: '/chat',
  headers: { accept: 'application/json', 'content-type': 'application/json' },
  payload: { message: 'Hello' },
})
expect(response.statusCode).toBe(200)

// SSE mode (autoClose handler)
const client = new SSEInjectClient(app)
const conn = await client.connectWithBody('/chat', { message: 'Hello' })

const events = conn.getReceivedEvents()
expect(events.filter(e => e.event === 'chunk').length).toBeGreaterThan(0)
expect(events.filter(e => e.event === 'done')).toHaveLength(1)
```
