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
- [SSE Rooms](#sse-rooms)
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

On top of the options `@lokalise/fastify-api-contracts` accepts, `buildApiRoute`
adds two:

| Option | Description |
|--------|-------------|
| `gatewayMetadata` | Per-route gateway policy, with `match.headers` / `match.query` keys narrowed to the contract. Equivalent to wrapping the route with `withGatewayMetadata()` |
| `sseRooms` | Enable SSE rooms for this route by passing the shared `SSERoomBroadcaster` (see [SSE Rooms](#sse-rooms)) |

## SSE Rooms

Room membership is off by default in `buildApiRoute` sessions:
`getSessionRooms(session)` returns no-ops and the session receives no
broadcasts. Pass the shared `SSERoomBroadcaster` via `options.sseRooms` to make
them real: the session joins/leaves rooms on the shared `SSERoomManager`,
receives `broadcastToRoom` / `broadcastMessage` deliveries, and is cleaned up
(rooms left, dedup cache cleared) when the connection closes.

`@lokalise/fastify-api-contracts` owns the `SSESession` shape and has no `rooms`
field, so room operations are reached through `getSessionRooms(session)` rather
than `session.rooms` (the accessor the legacy controllers expose).

This unlocks the polling-fallback serving pattern — one dual-mode route whose
sync branch answers snapshot polls while a domain service broadcasts events
into a room the SSE branch joined:

```ts
export class JobController extends AbstractApiController<typeof JobController.contracts> {
  public static contracts = { jobStatus: jobStatusContract } as const
  private readonly jobService: JobService
  private readonly sseRoomBroadcaster: SSERoomBroadcaster

  constructor({ jobService, sseRoomBroadcaster }: Dependencies) {
    super()
    this.jobService = jobService
    this.sseRoomBroadcaster = sseRoomBroadcaster
    this.routes = {
      jobStatus: buildApiRoute(
        JobController.contracts.jobStatus,
        (request, _reply, { expectedContentType, sse }) => {
          // Push channel: join the job's room and stay open
          if (expectedContentType === 'text/event-stream') {
            const session = sse.start('keepAlive')
            getSessionRooms(session).join(`job:${request.params.jobId}`)
            return
          }
          // Fallback poll: current snapshot, including its version
          return { status: 200, body: this.jobService.get(request.params.jobId) }
        },
        {
          sseRooms: this.sseRoomBroadcaster,
        },
      ),
    }
  }

  readonly routes: BuildApiRoutesReturnType<typeof JobController.contracts>
}

// Domain service, anywhere in the app — stamp monotonic ids so clients can
// order events (see createEventIdSequence):
await this.sseRoomBroadcaster.broadcastToRoom(`job:${jobId}`, doneEvent, { result }, {
  id: String(job.version),
})
```

Register `sseRoomManager` + `sseRoomBroadcaster` in DI exactly as for the
legacy controllers (see the root README's "SSE Rooms" section); the same
broadcaster instance can serve legacy controllers and `buildApiRoute` routes
simultaneously.

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

It returns these accessors:

- `closed` — resolves with `{ statusCode, headers, body }` once the response completes, exactly as with `injectSSE`.
- `head` — resolves with `{ statusCode, headers }` as soon as the response head is on the wire, which for a streaming handler is the moment it calls `sse.start()`. Assert the status of a stream without waiting for the handler to finish it.
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

- `stream()` — yields the same typed, validated events *as the handler writes them*, instead of after the response completes:

  ```ts
  const { stream } = injectApiSSE(app, lqaSegmentContract, { body: { segment } })

  for await (const event of stream()) {
    // observed while the handler is still working — `events()` cannot show this
    if (event.event === 'issue') expect(handlerFinished).toBe(false)
  }
  ```

  The request is injected with Fastify's `payloadAsStream`, so asserting progressive delivery ("event N reached the client while the handler was still producing N+1") needs no `app.listen()`, base URL or manual connection cleanup. Events are buffered from the moment the request is injected, so a generator started late still replays the stream from its first event, and the handler is never blocked by a slow or absent consumer. `stream(signal)` takes an optional `AbortSignal` to stop early.

  It throws the same errors `events()` does, and — like `events()` — is typed `never` for a contract that declares no SSE response.

  `closed` and `events()` still wait for the response to complete, so a route that never closes its stream (a `keepAlive` session) can only be read through `stream()`; use `connectApiSSE` against a real server for those.

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

### Testing SSE routes over real HTTP with the contract (`connectApiSSE`)

`injectApiSSE` covers streams that complete. When the endpoint keeps its connection open — a `keepAlive` session — the response never completes, so the test needs a real HTTP connection. `connectApiSSE` is that path, read through the contract: the method, path, query params, headers and body come from the contract instead of being repeated as string literals next to it, and the events are typed and validated exactly as `injectApiSSE().events()` types them.

```ts
import { connectApiSSE, SSETestServer } from 'opinionated-machine'

const server = await SSETestServer.start(app)
const client = await connectApiSSE(server.baseUrl, lqaSegmentContract, { body: { segment } })

// The response head is on the wire before the handler is done
expect(client.response.status).toBe(200)

for await (const event of client.events()) {
  if (event.event === 'issue') expect(event.data.severity).toBe('minor') // typed by the contract
  if (event.event === 'review') break
}

client.close()
await server.close()
```

`collectEvents(countOrPredicate, timeout?)` collects the same typed events, with the predicate seeing the narrowed union. For a `keepAlive` route, pass `awaitServerConnection` to also wait for the server-side session (wired via `createSSESessionSpy()`), the same way `SSEHttpClient.connect` does:

```ts
const { spy, routeOptions } = createSSESessionSpy()
// app.route(buildApiRoute(contract, handler, routeOptions))

const { client, serverConnection } = await connectApiSSE(
  server.baseUrl,
  channelFeedContract,
  { pathParams: { channelId: 'c-1' }, queryParams: {}, headers },
  { awaitServerConnection: { spy } },
)
await serverConnection.send('ping', { channelId: 'c-1', seq: 1 })
expect(await client.collectEvents(1)).toEqual([{ event: 'ping', data: { channelId: 'c-1', seq: 1 } }])
```

On a connection you already have — from `SSEHttpClient.connect` — the same typing is available per read: `client.apiEvents(contract)` and `client.collectApiEvents(contract, countOrPredicate)`.

### Testing SSE routes (keepAlive, without a contract)

Use `SSEHttpClient` against a real server:

```ts
import { SSEHttpClient, SSETestServer } from 'opinionated-machine'

const server = await SSETestServer.start(app)

const client = await SSEHttpClient.connect(server.baseUrl, '/updates/stream')

client.close()
await server.stop()
```

### When a handler fails to send an event

`session.send(name, payload)` validates the payload against the contract's schema for that event and throws when it doesn't match. That throw happens inside the handler: the event never reaches the wire, the stream just ends early with HTTP 200, and the ZodError only shows up in the server log — so the test sees an unrelated event missing.

Routes built with `buildApiRoute` report those failures back to the test that is reading the stream. When the failure is what ended the stream early — nothing in the route caught it — `events()`, `stream()` and the `connectApiSSE` readers throw with the offending event name, its Zod issues and the payload that was rejected:

```
events() — 1 SSE send failure recorded for this request:
  - event "issue" was never sent: severity: Invalid option: expected one of "neutral"|"minor"|"major"|"critical"; payload: {"severity":"min"}
```

A failure the route recovered from is reported, not raised: a handler that catches its own failed send and streams a fallback produced the response it meant to, and the readers deliver it unchanged. A `sendStream()` source that throws while producing its next message is likewise reported as the source failing, rather than blamed on the last event that did reach the client.

`injectApiSSE(...).sendFailures()` and `connectApiSSE(...).sendFailures()` expose every record (`{ eventName?, data?, message, issues?, error, handled }`), recovered ones included, for assertions the thrown message doesn't cover:

```ts
const { closed, events, sendFailures } = injectApiSSE(app, lqaSegmentContract, { body })
await closed

expect(await events()).toHaveLength(2) // the fallback stream is intact
expect(sendFailures()).toMatchObject([{ eventName: 'issue', handled: true }])
```

This is test-only, and costs production traffic nothing: the helpers tag their requests with an `x-om-sse-diagnostics-id` header, and a session is only instrumented when that header names a diagnostics scope open in the same process — something only the helpers create. A stale or forged header matches nothing.

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
