# ApiContract Controllers

The `lib/api-contracts/` module provides `AbstractApiController`, `asApiControllerClass`, and `buildApiRoute` — the DI-side glue for registering typed API routes (sync JSON, SSE, and dual-mode) using contracts from `@lokalise/api-contracts`.

The route-building, handler-shape inference, response validation, and SSE streaming logic itself lives in [`@lokalise/fastify-api-contracts`](https://github.com/lokalise/fastify-api-contracts) (`buildFastifyApiRoute`) — this module wraps it and adds:

- `AbstractApiController` — the controller base class `DIContext.registerRoutes()` understands
- `asApiControllerClass` — the awilix resolver that tags a controller with `isApiController`
- `buildApiRoute` — a thin wrapper over `buildFastifyApiRoute` that additionally accepts the `gatewayMetadata` option (contract-narrowed, stamped via the shared gateway Symbol)

## Table of Contents

- [Overview](#overview)
- [Defining Contracts](#defining-contracts)
- [Handler Model](#handler-model)
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
| Route builder | local implementation | `buildFastifyApiRoute` from `@lokalise/fastify-api-contracts` |

## Defining Contracts

Use `defineApiContract` from `@lokalise/api-contracts`. Response representations are declared per status code in `responsesByStatusCode`: a bare Zod schema is JSON, `sseBody(...)` inside a content map is an SSE stream, `blobBody()` is a raw body, and a status may declare several media types at once.

```ts
import { defineApiContract, noBodyResponse, sseBody } from '@lokalise/api-contracts'
import { z } from 'zod/v4'

// Sync JSON
const getUserContract = defineApiContract({
  method: 'get',
  summary: 'Get user',
  pathResolver: (p: { userId: string }) => `/users/${p.userId}`,
  requestPathParamsSchema: z.object({ userId: z.string() }),
  responsesByStatusCode: {
    200: z.object({ id: z.string(), name: z.string() }),
  },
})

// SSE
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

// Dual-mode (JSON and SSE on the same status)
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

## Handler Model

Every handler has the same shape — `(request, reply, context) => { status, body }` — regardless of response mode (this is `buildFastifyApiRoute`'s model; see its docs for the full semantics):

- **`request`** is fully typed from the contract's request schemas.
- **`reply`** is the Fastify reply minus `send()` — the framework sends the response after validation.
- **`context.expectedContentType`** is the `Accept`-negotiated response content-type among the contract's success representations (`null` when the client expressed no acceptable preference).
- **`context.sse`** exists only for contracts that declare an SSE response; `context.sse.start(mode)` opens the stream imperatively and returns a typed session (after which the handler returns nothing).
- Returning `{ status, body }` where the status's representation is `sseBody(...)` streams the returned `AsyncIterable` of events declaratively.
- When a status declares several media types, the result must carry `contentType`: `{ status, contentType, body }`.

Response bodies are validated by the `fastify-type-provider-zod` serializer compiler — register `validatorCompiler` / `serializerCompiler` on the app. SSE-capable routes require the `@fastify/sse` plugin.

### Error handling

Errors thrown by handlers propagate to the app's global `fastify.setErrorHandler` — including on SSE routes — as described in the `@lokalise/fastify-api-contracts` README. The route builder adds no error mapping of its own: if you rely on the node-core `httpStatusCode` convention or want a terminal SSE `error` event when a handler throws mid-stream, implement it in the global error handler.

## Creating a Controller

Extend `AbstractApiController` with a `static contracts` object and a `routes` object built with `buildApiRoute`. The generic ensures every contract has a matching named route:

```ts
import { AbstractApiController, buildApiRoute } from 'opinionated-machine'

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
    // Sync JSON: return { status, body }
    getUser: buildApiRoute(UserController.contracts.getUser, async (request) => ({
      status: 200,
      body: await this.userService.findById(request.params.userId),
    })),

    // No-body response
    deleteUser: buildApiRoute(UserController.contracts.deleteUser, async (request) => {
      await this.userService.delete(request.params.userId)
      return { status: 204, body: null }
    }),

    // SSE: stream imperatively via context.sse
    streamUpdates: buildApiRoute(
      UserController.contracts.streamUpdates,
      async (_request, _reply, { sse }) => {
        sse.start('keepAlive')
      },
    ),

    // Dual-mode: one handler, branch on the negotiated content-type
    chat: buildApiRoute(
      UserController.contracts.chat,
      async (request, _reply, { expectedContentType, sse }) => {
        if (expectedContentType === 'text/event-stream') {
          const session = sse.start('autoClose')
          for await (const chunk of this.aiService.stream(request.body.message)) {
            await session.send('chunk', { delta: chunk.text })
          }
          await session.send('done', {})
          return
        }
        const result = await this.aiService.complete(request.body.message)
        return { status: 200, contentType: 'application/json', body: { reply: result.text } }
      },
    ),
  }
}
```

### SSE session methods

The `session` returned by `sse.start(mode)` (`'autoClose'` closes the connection when the handler returns; `'keepAlive'` keeps it open until `session.close()`):

| Method | Description |
|--------|-------------|
| `session.send(event, data)` | Send a typed event (validated against contract schema) |
| `session.isConnected()` | Whether the client is still connected |
| `session.sendStream(iterable)` | Stream messages from an `AsyncIterable` |
| `session.getStream()` | Raw writable stream for advanced use |
| `session.close()` | Close the connection from the server side |

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

Pass options as the third argument to `buildApiRoute`. Everything except `gatewayMetadata` is forwarded to `buildFastifyApiRoute` unchanged:

```ts
buildApiRoute(contract, handler, {
  // Run before the handler — for auth/authorization
  preHandler: async (request, reply) => {
    if (!request.headers.authorization) {
      reply.code(401).send({ error: 'Unauthorized' })
    }
  },

  // SSE connection lifecycle hooks (SSE-capable contracts only)
  onConnect: (session) => console.log('connected:', session.id),
  onClose: (session, initiator) => console.log(`closed (${initiator}):`, session.id),
  onReconnect: async (session, lastEventId) => this.getEventsSince(lastEventId),

  // Custom SSE serializer
  serializer: (data) => JSON.stringify(data),

  // Disable the SSE keep-alive heartbeat for this route
  heartbeat: false,

  // Map contract metadata to Fastify route options
  contractMetadataToRouteMapper: (metadata) => ({
    config: { rateLimit: metadata.rateLimit },
  }),

  // opinionated-machine addition: per-route gateway policy,
  // equivalent to wrapping the route with withGatewayMetadata()
  gatewayMetadata: {
    cache: { ttl: '60s' },
    match: { headers: { 'x-trace-id': { regex: '^[a-f0-9]+$' } } },
  },
})
```

Any other [Fastify `RouteOptions`](https://fastify.dev/docs/latest/Reference/Routes/) fields (`bodyLimit`, `onRequest`, `config`, etc.) can also be passed and are forwarded directly to Fastify. The contract itself is exposed as `config.apiContract` on the built route.

## Testing

### Testing sync JSON routes

Use Fastify's `app.inject()` as normal. The status code comes from the `status` field of the returned `{ status, body }` object:

```ts
const response = await app.inject({
  method: 'GET',
  url: '/users/123',
})
expect(response.statusCode).toBe(200)
expect(JSON.parse(response.body)).toEqual({ id: '123', name: 'Alice' })
```

### Testing SSE routes with the contract (`injectApiSSE`)

`injectApiSSE` is the `defineApiContract` counterpart of `injectSSE` / `injectPayloadSSE` (which are typed against the legacy `SSEContractDefinition`). One function covers every method — the HTTP verb comes from the contract — and `params` is the same shape `injectByApiContract` takes, so a body is required exactly when the contract declares `requestBodySchema`:

```ts
import { injectApiSSE } from 'opinionated-machine'

const lqaSegmentContract = defineApiContract({
  visibility: 'internal',
  method: 'post',
  summary: 'Perform LQA on a text segment',
  pathResolver: () => '/v1/content/actions/lqa-text-segment',
  requestBodySchema: z.object({ segment: z.string() }),
  responsesByStatusCode: {
    200: sseResponse({ review: z.object({ score: z.number() }) }),
    400: z.object({ message: z.string() }),
  },
})

const { closed, events, bodyForStatus } = injectApiSSE(app, lqaSegmentContract, {
  body: { segment: 'hello' },
})
```

It returns three accessors:

- `closed` — resolves with `{ statusCode, headers, body }` once the response completes, exactly as with `injectSSE`.
- `events()` — parses the SSE body and validates each event against the contract's `sseResponse` / `sseBody` schemas, returning a union discriminated on `event`:

  ```ts
  for (const event of await events()) {
    if (event.event === 'review') {
      expect(event.data.score).toBeGreaterThan(0) // `data` typed by the `review` schema
    }
  }
  ```

  It throws if the response isn't an SSE stream, if an event name isn't declared by the contract, or if a payload fails its schema.

  The events are typed from the SSE schemas of *every* status the contract declares — not just the successful ones — merged exactly as `getSseSchemaByEventName` merges them at runtime. A contract streaming `tick` on `200` and `failure` on `'4xx'` types `events()` as the union of both. A contract that declares no SSE response at all types `events` as `never`, so calling it is a compile error rather than a guaranteed throw.

- `bodyForStatus(status)` — asserts the status, JSON-parses the body, and validates it against the JSON schema `responsesByStatusCode` declares for that status. Intended for the documented error responses a handler emits (as `{ status, body }`) before streaming starts:

  ```ts
  const error = await injectApiSSE(app, lqaSegmentContract, {
    body: { segment: '' },
  }).bodyForStatus(400)
  expect(error.message).toBe('segment must not be empty')
  ```

  `status` is constrained at the type level to the statuses the contract declares a *reachable* JSON body for; range keys (`'4xx'`) and `'default'` expand to the concrete statuses they serve, following the same exact → range → `'default'` precedence the contract client uses.

  `injectApiSSE` always sends `accept: text/event-stream`, so any status declaring a stream answers with the stream. Such a status isn't callable here — not only an SSE-only one, but also a dual-mode status whose content map carries both a JSON schema and an `sseBody`:

  ```ts
  const feedContract = defineApiContract({
    // ...
    responsesByStatusCode: {
      200: {
        content: {
          'application/json': summarySchema,
          'text/event-stream': sseBody({ update: z.object({ value: z.number() }) }),
        },
      },
    },
  })

  const { events, bodyForStatus } = injectApiSSE(app, feedContract, { queryParams: {} })

  await events() // the stream — this is what the route answers with
  // @ts-expect-error — 200 has no JSON body reachable through injectApiSSE
  await bodyForStatus(200)
  ```

  Reach for `injectByApiContract` when you want the JSON side of such a status instead.

Query params, path params, headers (a plain object or a sync/async factory) and `pathPrefix` all come from the contract-derived params:

```ts
const events = await injectApiSSE(app, tickStreamContract, {
  pathParams: { channelId: 'c-1' },
  queryParams: { count: 2 },
  headers: async () => ({ authorization: await issueToken() }),
}).events()
```

### Testing SSE routes (autoClose)

Use `SSEInjectClient` — no real HTTP server needed:

```ts
import { SSEInjectClient } from 'opinionated-machine'

const client = new SSEInjectClient(app)
const conn = await client.connect('/updates/stream')

expect(conn.getStatusCode()).toBe(200)
const events = conn.getReceivedEvents()
expect(events.filter(e => e.event === 'done')).toHaveLength(1)
```

### Testing SSE routes (keepAlive)

Use `SSEHttpClient` against a real server:

```ts
import { SSEHttpClient, SSETestServer } from 'opinionated-machine'

const server = await SSETestServer.start(app)

const client = await SSEHttpClient.connect(server.baseUrl, '/updates/stream')

client.close()
await server.stop()
```

### Testing dual-mode routes

```ts
// JSON mode
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
