# opinionated-machine
Very opinionated DI framework for fastify, built on top of awilix

## Table of Contents

- [Basic usage](#basic-usage)
- [Defining controllers](#defining-controllers)
- [Putting it all together](#putting-it-all-together)
- [Resolver Functions](#resolver-functions)
  - [Basic Resolvers](#basic-resolvers)
    - [`asSingletonClass`](#assingletonclasstype-opts)
    - [`asSingletonFunction`](#assingletonfunctionfn-opts)
    - [`asClassWithConfig`](#asclasswithconfigtype-config-opts)
  - [Domain Layer Resolvers](#domain-layer-resolvers)
    - [`asServiceClass`](#asserviceclasstype-opts)
    - [`asUseCaseClass`](#asusecaseclasstype-opts)
    - [`asRepositoryClass`](#asrepositoryclasstype-opts)
    - [`asControllerClass`](#ascontrollerclasstype-opts)
    - [`asSSEControllerClass`](#asssecontrollerclasstype-sseoptions-opts)
    - [`asDualModeControllerClass`](#asdualmodecontrollerclasstype-sseoptions-opts)
  - [Message Queue Resolvers](#message-queue-resolvers)
    - [`asMessageQueueHandlerClass`](#asmessagequeuehandlerclasstype-mqoptions-opts)
  - [Background Job Resolvers](#background-job-resolvers)
    - [`asEnqueuedJobWorkerClass`](#asenqueuedjobworkerclasstype-workeroptions-opts)
    - [`asPgBossProcessorClass`](#aspgbossprocessorclasstype-processoroptions-opts)
    - [`asPeriodicJobClass`](#asperiodicjobclasstype-workeroptions-opts)
    - [`asJobQueueClass`](#asjobqueueclasstype-queueoptions-opts)
    - [`asEnqueuedJobQueueManagerFunction`](#asenqueuedjobqueuemanagerfunctionfn-dioptions-opts)
- [Server-Sent Events (SSE)](#server-sent-events-sse)
  - [Prerequisites](#prerequisites)
  - [Defining SSE Contracts](#defining-sse-contracts)
  - [Creating SSE Controllers](#creating-sse-controllers)
  - [Type-Safe SSE Handlers with buildHandler](#type-safe-sse-handlers-with-buildhandler)
  - [SSE Controllers Without Dependencies](#sse-controllers-without-dependencies)
  - [Registering SSE Controllers](#registering-sse-controllers)
  - [Registering SSE Routes](#registering-sse-routes)
  - [Broadcasting Events](#broadcasting-events)
  - [Controller-Level Hooks](#controller-level-hooks)
  - [Route-Level Options](#route-level-options)
  - [Graceful Shutdown](#graceful-shutdown)
  - [Error Handling](#error-handling)
  - [Long-lived Connections vs Request-Response Streaming](#long-lived-connections-vs-request-response-streaming)
  - [SSE Parsing Utilities](#sse-parsing-utilities)
    - [parseSSEEvents](#parsesseevents)
    - [parseSSEBuffer](#parsessebuffer)
    - [ParsedSSEEvent Type](#parsedsseevent-type)
  - [Testing SSE Controllers](#testing-sse-controllers)
  - [SSEConnectionSpy API](#sseconnectionspy-api)
  - [Connection Monitoring](#connection-monitoring)
  - [SSE Test Utilities](#sse-test-utilities)
    - [Quick Reference](#quick-reference)
    - [Inject vs HTTP Comparison](#inject-vs-http-comparison)
    - [SSETestServer](#ssetestserver)
    - [SSEHttpClient](#ssehttpclient)
    - [SSEInjectClient](#sseinjectclient)
    - [Contract-Aware Inject Helpers](#contract-aware-inject-helpers)
- [Dual-Mode Controllers (SSE + JSON)](#dual-mode-controllers-sse--json)
  - [Overview](#overview)
  - [Defining Dual-Mode Contracts](#defining-dual-mode-contracts)
  - [Implementing Dual-Mode Controllers](#implementing-dual-mode-controllers)
  - [Registering Dual-Mode Controllers](#registering-dual-mode-controllers)
  - [Accept Header Routing](#accept-header-routing)
  - [Testing Dual-Mode Controllers](#testing-dual-mode-controllers)

## Basic usage

Define a module, or several modules, that will be used for resolving dependency graphs, using awilix:

```ts
import { AbstractModule, asSingletonClass, asMessageQueueHandlerClass, asJobWorkerClass, asJobQueueClass, asControllerClass } from 'opinionated-machine'

export type ModuleDependencies = {
    service: Service
    messageQueueConsumer: MessageQueueConsumer
    jobWorker: JobWorker
    queueManager: QueueManager
}

export class MyModule extends AbstractModule<ModuleDependencies, ExternalDependencies> {
    resolveDependencies(
        diOptions: DependencyInjectionOptions,
        _externalDependencies: ExternalDependencies,
    ): MandatoryNameAndRegistrationPair<ModuleDependencies> {
        return {
            service: asSingletonClass(Service),

            // by default init and disposal methods from `message-queue-toolkit` consumers
            // will be assumed. If different values are necessary, pass second config object
            // and specify "asyncInit" and "asyncDispose" fields
            messageQueueConsumer: asMessageQueueHandlerClass(MessageQueueConsumer, {
                queueName: MessageQueueConsumer.QUEUE_ID,
                diOptions,
            }),

            // by default init and disposal methods from `background-jobs-commons` job workers
            // will be assumed. If different values are necessary, pass second config object
            // and specify "asyncInit" and "asyncDispose" fields
            jobWorker: asEnqueuedJobWorkerClass(JobWorker, {
                queueName: JobWorker.QUEUE_ID,
                diOptions,
            }),

            // by default disposal methods from `background-jobs-commons` job queue manager
            // will be assumed. If different values are necessary, specify "asyncDispose" fields 
            // in the second config object
            queueManager: asJobQueueClass(
                QueueManager,
                {
                    diOptions,
                },
                {
                    asyncInit: (manager) => manager.start(resolveJobQueuesEnabled(options)),
                },
            ),
        }
    }

    // controllers will be automatically registered on fastify app
    // both REST and SSE controllers go here - SSE controllers are auto-detected
    resolveControllers(diOptions: DependencyInjectionOptions) {
        return {
            controller: asControllerClass(MyController),
        }
    }
}
```

## Defining controllers

Controllers require using fastify-api-contracts and allow to define application routes.

```ts
import { buildFastifyNoPayloadRoute } from '@lokalise/fastify-api-contracts'
import { buildDeleteRoute } from '@lokalise/universal-ts-utils/api-contracts/apiContracts'
import { z } from 'zod/v4'
import { AbstractController } from 'opinionated-machine'

const BODY_SCHEMA = z.object({})
const PATH_PARAMS_SCHEMA = z.object({
  userId: z.string(),
})

const contract = buildDeleteRoute({
  successResponseBodySchema: BODY_SCHEMA,
  requestPathParamsSchema: PATH_PARAMS_SCHEMA,
  pathResolver: (pathParams) => `/users/${pathParams.userId}`,
})

export class MyController extends AbstractController<typeof MyController.contracts> {
  public static contracts = { deleteItem: contract } as const
  private readonly service: Service

  constructor({ service }: ModuleDependencies) {
      super()
      this.service = testService
  }

    private deleteItem = buildFastifyNoPayloadRoute(
        TestController.contracts.deleteItem,
        async (req, reply) => {
            req.log.info(req.params.userId)
            this.service.execute()
            await reply.status(204).send()
        },
    )

    public buildRoutes() {
        return {
            deleteItem: this.deleteItem,
        }
    }
}
```

## Putting it all together

Typical usage with a fastify app looks like this:

```ts
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { createContainer } from 'awilix'
import { fastify } from 'fastify'
import { DIContext } from 'opinionated-machine'

const module = new MyModule()
const container = createContainer({
    injectionMode: 'PROXY',
})

type AppConfig = {
    DATABASE_URL: string
    // ...
    // everything related to app configuration
}

type ExternalDependencies = {
    logger: Logger // most likely you would like to reuse logger instance from fastify app
}

const context = new DIContext<ModuleDependencies, AppConfig, ExternalDependencies>(container, {
    messageQueueConsumersEnabled: [MessageQueueConsumer.QUEUE_ID],
    jobQueuesEnabled: false,
    jobWorkersEnabled: false,
    periodicJobsEnabled: false,
})

context.registerDependencies({
    modules: [module],
    dependencyOverrides: {}, // dependency overrides if necessary, usually for testing purposes
    configOverrides: {}, // config overrides if necessary, will be merged with value inside existing config
    configDependencyId?: string // what is the dependency id in the graph for the config entity. Only used for config overrides. Default value is `config`
}, 
    // external dependencies that are instantiated outside of DI
    {
    logger: app.logger
})

const app = fastify()
app.setValidatorCompiler(validatorCompiler)
app.setSerializerCompiler(serializerCompiler)

app.after(() => {
    context.registerRoutes(app)
})
await app.ready()
```

## Resolver Functions

The library provides a set of resolver functions that wrap awilix's `asClass` and `asFunction` with sensible defaults for different types of dependencies. All resolvers create singletons by default.

### Basic Resolvers

#### `asSingletonClass(Type, opts?)`
Basic singleton class resolver. Use for general-purpose dependencies that don't fit other categories.

```ts
service: asSingletonClass(MyService)
```

#### `asSingletonFunction(fn, opts?)`
Basic singleton function resolver. Use when you need to resolve a dependency using a factory function.

```ts
config: asSingletonFunction(() => loadConfig())
```

#### `asClassWithConfig(Type, config, opts?)`
Register a class with an additional config parameter passed to the constructor. Uses `asFunction` wrapper internally to pass the config as a second parameter. Requires PROXY injection mode.

```ts
myService: asClassWithConfig(MyService, { enableFeature: true })
```

The class constructor receives dependencies as the first parameter and config as the second:

```ts
class MyService {
  constructor(deps: Dependencies, config: { enableFeature: boolean }) {
    // ...
  }
}
```

### Domain Layer Resolvers

#### `asServiceClass(Type, opts?)`
For service classes. Marks the dependency as **public** (exposed when module is used as secondary).

```ts
userService: asServiceClass(UserService)
```

#### `asUseCaseClass(Type, opts?)`
For use case classes. Marks the dependency as **public**.

```ts
createUserUseCase: asUseCaseClass(CreateUserUseCase)
```

#### `asRepositoryClass(Type, opts?)`
For repository classes. Marks the dependency as **private** (not exposed when module is secondary).

```ts
userRepository: asRepositoryClass(UserRepository)
```

#### `asControllerClass(Type, opts?)`
For REST controller classes. Marks the dependency as **private**. Use in `resolveControllers()`.

```ts
userController: asControllerClass(UserController)
```

#### `asSSEControllerClass(Type, sseOptions?, opts?)`
For SSE controller classes. Marks the dependency as **private** with `isSSEController: true` for auto-detection. Automatically configures `closeAllConnections` as the async dispose method for graceful shutdown. When `sseOptions.diOptions.isTestMode` is true, enables the connection spy for testing. Use in `resolveControllers()` alongside REST controllers.

```ts
// In resolveControllers()
resolveControllers(diOptions: DependencyInjectionOptions) {
  return {
    userController: asControllerClass(UserController),
    notificationsSSEController: asSSEControllerClass(NotificationsSSEController, { diOptions }),
  }
}
```

#### `asDualModeControllerClass(Type, sseOptions?, opts?)`
For dual-mode controller classes that handle both SSE and JSON responses on the same route. Marks the dependency as **private** with `isDualModeController: true` for auto-detection. Inherits all SSE controller features including connection management and graceful shutdown. When `sseOptions.diOptions.isTestMode` is true, enables the connection spy for testing SSE mode.

```ts
// In resolveControllers()
resolveControllers(diOptions: DependencyInjectionOptions) {
  return {
    userController: asControllerClass(UserController),
    chatController: asDualModeControllerClass(ChatDualModeController, { diOptions }),
  }
}
```

### Message Queue Resolvers

#### `asMessageQueueHandlerClass(Type, mqOptions, opts?)`
For message queue consumers following `message-queue-toolkit` conventions. Automatically handles `start`/`close` lifecycle and respects `messageQueueConsumersEnabled` option.

```ts
messageQueueConsumer: asMessageQueueHandlerClass(MessageQueueConsumer, {
    queueName: MessageQueueConsumer.QUEUE_ID,
    diOptions,
})
```

### Background Job Resolvers

#### `asEnqueuedJobWorkerClass(Type, workerOptions, opts?)`
For enqueued job workers following `background-jobs-common` conventions. Automatically handles `start`/`dispose` lifecycle and respects `enqueuedJobWorkersEnabled` option.

```ts
jobWorker: asEnqueuedJobWorkerClass(JobWorker, {
    queueName: JobWorker.QUEUE_ID,
    diOptions,
})
```

#### `asPgBossProcessorClass(Type, processorOptions, opts?)`
For pg-boss job processor classes. Similar to `asEnqueuedJobWorkerClass` but uses `start`/`stop` lifecycle methods and initializes after pgBoss (priority 20).

```ts
enrichUserPresenceJob: asPgBossProcessorClass(EnrichUserPresenceJob, {
    queueName: EnrichUserPresenceJob.QUEUE_ID,
    diOptions,
})
```

#### `asPeriodicJobClass(Type, workerOptions, opts?)`
For periodic job classes following `background-jobs-common` conventions. Uses eager injection via `register` method and respects `periodicJobsEnabled` option.

```ts
cleanupJob: asPeriodicJobClass(CleanupJob, {
    jobName: CleanupJob.JOB_NAME,
    diOptions,
})
```

#### `asJobQueueClass(Type, queueOptions, opts?)`
For job queue classes. Marks the dependency as **public**. Respects `jobQueuesEnabled` option.

```ts
queueManager: asJobQueueClass(QueueManager, {
    diOptions,
})
```

#### `asEnqueuedJobQueueManagerFunction(fn, diOptions, opts?)`
For job queue manager factory functions. Automatically calls `start()` with resolved enabled queues during initialization.

```ts
jobQueueManager: asEnqueuedJobQueueManagerFunction(
    createJobQueueManager,
    diOptions,
)
```

## Server-Sent Events (SSE)

The library provides first-class support for Server-Sent Events using [@fastify/sse](https://github.com/fastify/sse). SSE enables real-time, unidirectional streaming from server to client - perfect for notifications, live updates, and streaming responses (like AI chat completions).

### Prerequisites

Register the `@fastify/sse` plugin before using SSE controllers:

```ts
import FastifySSEPlugin from '@fastify/sse'

const app = fastify()
await app.register(FastifySSEPlugin)
```

### Defining SSE Contracts

Use `buildContract` to define SSE routes. The contract type is automatically determined based on the presence of `body` and `syncResponse` fields. Paths are defined using `pathResolver`, a type-safe function that receives typed params and returns the URL path:

```ts
import { z } from 'zod'
import { buildContract } from 'opinionated-machine'

// GET-based SSE stream with path params (no body = GET)
export const channelStreamContract = buildContract({
  pathResolver: (params) => `/api/channels/${params.channelId}/stream`,
  params: z.object({ channelId: z.string() }),
  query: z.object({}),
  requestHeaders: z.object({}),
  events: {
    message: z.object({ content: z.string() }),
  },
})

// GET-based SSE stream without path params
export const notificationsContract = buildContract({
  pathResolver: () => '/api/notifications/stream',
  params: z.object({}),
  query: z.object({ userId: z.string().optional() }),
  requestHeaders: z.object({}),
  events: {
    notification: z.object({
      id: z.string(),
      message: z.string(),
    }),
  },
})

// POST-based SSE stream (e.g., AI chat completions) - has body = POST/PUT/PATCH
export const chatCompletionContract = buildContract({
  method: 'POST',
  pathResolver: () => '/api/chat/completions',
  params: z.object({}),
  query: z.object({}),
  requestHeaders: z.object({}),
  body: z.object({
    message: z.string(),
    stream: z.literal(true),
  }),
  events: {
    chunk: z.object({ content: z.string() }),
    done: z.object({ totalTokens: z.number() }),
  },
})
```

For reusable event schema definitions, you can use the `SSEEventSchemas` type (requires TypeScript 4.9+ for `satisfies`):

```ts
import { z } from 'zod'
import { type SSEEventSchemas } from 'opinionated-machine'

// Define reusable event schemas for multiple contracts
const streamingEvents = {
  chunk: z.object({ content: z.string() }),
  done: z.object({ totalTokens: z.number() }),
  error: z.object({ code: z.number(), message: z.string() }),
} satisfies SSEEventSchemas
```

### Creating SSE Controllers

SSE controllers extend `AbstractSSEController` and must implement a two-parameter constructor. Use `buildHandler` for automatic type inference of request parameters:

```ts
import {
  AbstractSSEController,
  buildHandler,
  type SSEControllerConfig,
  type SSEConnection
} from 'opinionated-machine'

type Contracts = {
  notificationsStream: typeof notificationsContract
}

type Dependencies = {
  notificationService: NotificationService
}

export class NotificationsSSEController extends AbstractSSEController<Contracts> {
  public static contracts = {
    notificationsStream: notificationsContract,
  } as const

  private readonly notificationService: NotificationService

  // Required: two-parameter constructor (deps object, optional SSE config)
  constructor(deps: Dependencies, sseConfig?: SSEControllerConfig) {
    super(deps, sseConfig)
    this.notificationService = deps.notificationService
  }

  public buildSSERoutes() {
    return {
      notificationsStream: {
        contract: NotificationsSSEController.contracts.notificationsStream,
        handlers: this.handleStream,
        options: {
          onConnect: (conn) => this.onConnect(conn),
          onDisconnect: (conn) => this.onDisconnect(conn),
        },
      },
    }
  }

  // Handler with automatic type inference from contract
  // connection.send provides type-safe event sending
  private handleStream = buildHandler(notificationsContract, {
    sse: async (request, connection) => {
      // request.query is typed from contract: { userId?: string }
      const userId = request.query.userId ?? 'anonymous'
      connection.context = { userId }

      // For external triggers (subscriptions, timers, message queues), use sendEventInternal.
      // connection.send is only available within this handler's scope - external callbacks
      // like subscription handlers execute later, outside this function, so they can't access connection.
      // sendEventInternal is a controller method, so it's accessible from any callback.
      // It provides autocomplete for all event names defined in the controller's contracts.
      this.notificationService.subscribe(userId, async (notification) => {
        await this.sendEventInternal(connection.id, {
          event: 'notification',
          data: notification,
        })
      })

      // For direct sending within the handler, use the connection's send method.
      // It provides stricter per-route typing (only events from this specific contract).
      await connection.send('notification', { id: 'welcome', message: 'Connected!' })
    },
  })

  private onConnect = (connection: SSEConnection) => {
    console.log('Client connected:', connection.id)
  }

  private onDisconnect = (connection: SSEConnection) => {
    const userId = connection.context?.userId as string
    this.notificationService.unsubscribe(userId)
    console.log('Client disconnected:', connection.id)
  }
}
```

### Type-Safe SSE Handlers with `buildHandler`

For automatic type inference of request parameters (similar to `buildFastifyPayloadRoute` for regular controllers), use `buildHandler`:

```ts
import {
  AbstractSSEController,
  buildHandler,
  type SSEControllerConfig,
  type SSEConnection
} from 'opinionated-machine'

class ChatSSEController extends AbstractSSEController<Contracts> {
  public static contracts = {
    chatCompletion: chatCompletionContract,
  } as const

  constructor(deps: Dependencies, sseConfig?: SSEControllerConfig) {
    super(deps, sseConfig)
  }

  // Handler with automatic type inference from contract
  // connection.send is fully typed per-route
  private handleChatCompletion = buildHandler(chatCompletionContract, {
    sse: async (request, connection) => {
      // request.body is typed as { message: string; stream: true }
      // request.query, request.params, request.headers all typed from contract
      const words = request.body.message.split(' ')

      for (const word of words) {
        // connection.send() provides compile-time type checking for event names and data
        await connection.send('chunk', { content: word })
      }

      // Gracefully end the stream - all sent data is flushed before connection closes
      this.closeConnection(connection.id)
    },
  })

  public buildSSERoutes() {
    return {
      chatCompletion: {
        contract: ChatSSEController.contracts.chatCompletion,
        handlers: this.handleChatCompletion,
      },
    }
  }
}
```

You can also use `InferSSERequest<Contract>` for manual type annotation when needed:

```ts
import { type InferSSERequest, type SSEConnection } from 'opinionated-machine'

private handleStream = async (
  request: InferSSERequest<typeof chatCompletionContract>,
  connection: SSEConnection<typeof chatCompletionContract['events']>,
) => {
  // request.body, request.params, etc. all typed from contract
  // connection.send() is typed based on contract events
  await connection.send('chunk', { content: 'hello' })
}
```

### SSE Controllers Without Dependencies

For controllers without dependencies, still provide the two-parameter constructor:

```ts
export class SimpleSSEController extends AbstractSSEController<Contracts> {
  constructor(deps: object, sseConfig?: SSEControllerConfig) {
    super(deps, sseConfig)
  }

  // ... implementation
}
```

### Registering SSE Controllers

Use `asSSEControllerClass` in your module's `resolveControllers` method alongside REST controllers. SSE controllers are automatically detected via the `isSSEController` flag and registered in the DI container:

```ts
import { AbstractModule, asControllerClass, asSSEControllerClass, asServiceClass, type DependencyInjectionOptions } from 'opinionated-machine'

export class NotificationsModule extends AbstractModule<Dependencies> {
  resolveDependencies() {
    return {
      notificationService: asServiceClass(NotificationService),
    }
  }

  resolveControllers(diOptions: DependencyInjectionOptions) {
    return {
      // REST controller
      usersController: asControllerClass(UsersController),
      // SSE controller (automatically detected and registered for SSE routes)
      notificationsSSEController: asSSEControllerClass(NotificationsSSEController, { diOptions }),
    }
  }
}
```

### Registering SSE Routes

Call `registerSSERoutes` after registering the `@fastify/sse` plugin:

```ts
const app = fastify()
app.setValidatorCompiler(validatorCompiler)
app.setSerializerCompiler(serializerCompiler)

// Register @fastify/sse plugin first
await app.register(FastifySSEPlugin)

// Then register SSE routes
context.registerSSERoutes(app)

// Optionally with global preHandler for authentication
context.registerSSERoutes(app, {
  preHandler: async (request, reply) => {
    if (!request.headers.authorization) {
      reply.code(401).send({ error: 'Unauthorized' })
    }
  },
})

await app.ready()
```

### Broadcasting Events

Send events to multiple connections using `broadcast()` or `broadcastIf()`:

```ts
// Broadcast to ALL connected clients
await this.broadcast({
  event: 'system',
  data: { message: 'Server maintenance in 5 minutes' },
})

// Broadcast to connections matching a predicate
await this.broadcastIf(
  { event: 'channel-update', data: { channelId: '123', newMessage: msg } },
  (connection) => connection.context.channelId === '123',
)
```

Both methods return the number of clients the message was successfully sent to.

### Controller-Level Hooks

Override these optional methods on your controller for global connection handling:

```ts
class MySSEController extends AbstractSSEController<Contracts> {
  // Called AFTER connection is registered (for all routes)
  protected onConnectionEstablished(connection: SSEConnection): void {
    this.metrics.incrementConnections()
  }

  // Called BEFORE connection is unregistered (for all routes)
  protected onConnectionClosed(connection: SSEConnection): void {
    this.metrics.decrementConnections()
  }
}
```

### Route-Level Options

Each route can have its own `preHandler`, lifecycle hooks, and logger:

```ts
public buildSSERoutes() {
  return {
    adminStream: {
      contract: AdminSSEController.contracts.adminStream,
      handlers: this.handleAdminStream,
      options: {
        // Route-specific authentication
        preHandler: (request, reply) => {
          if (!request.user?.isAdmin) {
            reply.code(403).send({ error: 'Forbidden' })
          }
        },
        onConnect: (conn) => console.log('Admin connected'),
        onDisconnect: (conn) => console.log('Admin disconnected'),
        // Handle client reconnection with Last-Event-ID
        onReconnect: async (conn, lastEventId) => {
          // Return events to replay, or handle manually
          return this.getEventsSince(lastEventId)
        },
        // Optional: logger for error handling (requires @lokalise/node-core)
        logger: this.logger,
      },
    },
  }
}
```

**Available route options:**

| Option | Description |
|--------|-------------|
| `preHandler` | Authentication/authorization hook that runs before SSE connection |
| `onConnect` | Called after client connects (SSE handshake complete) |
| `onDisconnect` | Called when client disconnects |
| `onReconnect` | Handle Last-Event-ID reconnection, return events to replay |
| `logger` | Optional `SSELogger` for error handling (compatible with pino and `@lokalise/node-core`). If not provided, errors in lifecycle hooks are silently ignored |

### Graceful Shutdown

SSE controllers automatically close all connections during application shutdown. This is configured by `asSSEControllerClass` which sets `closeAllConnections` as the async dispose method with priority 5 (early in shutdown sequence).

### Error Handling

When `sendEvent()` fails (e.g., client disconnected), it:
- Returns `false` to indicate failure
- Automatically removes the dead connection from tracking
- Prevents further send attempts to that connection

```ts
const sent = await this.sendEvent(connectionId, { event: 'update', data })
if (!sent) {
  // Connection was closed or failed - already removed from tracking
  this.cleanup(connectionId)
}
```

**Lifecycle hook errors** (`onConnect`, `onReconnect`, `onDisconnect`):
- All lifecycle hooks are wrapped in try/catch to prevent crashes
- If a `logger` is provided in route options, errors are logged with context
- If no logger is provided, errors are silently ignored
- The connection lifecycle continues even if a hook throws

```ts
// Provide a logger to capture lifecycle errors
public buildSSERoutes() {
  return {
    stream: {
      contract: streamContract,
      handlers: this.handleStream,
      options: {
        logger: this.logger, // pino-compatible logger
        onConnect: (conn) => { /* may throw */ },
        onDisconnect: (conn) => { /* may throw */ },
      },
    },
  }
}
```

### Long-lived Connections vs Request-Response Streaming

**Long-lived connections** (notifications, live updates):
- Handler sets up subscriptions and returns
- Connection stays open until client disconnects
- Use `sendEventInternal()` for external triggers (typed with union of all contract events)

```ts
private handleStream = buildHandler(streamContract, {
  sse: async (request, connection) => {
    // External callbacks (subscriptions, timers) can't access `connection` - it's only in this scope.
    // Use sendEventInternal instead - it's a controller method accessible from any callback.
    this.service.subscribe(connection.id, (data) => {
      this.sendEventInternal(connection.id, { event: 'update', data })
    })
    // Handler returns, connection stays open
  },
})
```

**Request-response streaming** (AI completions):
- Handler sends all events and closes connection
- Use `ctx.connection.send` for type-safe event sending

```ts
private handleChatCompletion = buildHandler(chatCompletionContract, {
  sse: async (request, connection) => {
    // request.body is typed from contract
    const words = request.body.message.split(' ')

    for (const word of words) {
      // connection.send() provides compile-time type checking for event names and data
      await connection.send('chunk', { content: word })
    }

    await connection.send('done', { totalTokens: words.length })

    // Gracefully end the stream - all sent data is flushed before connection closes
    this.closeConnection(connection.id)
  },
})
```

### SSE Parsing Utilities

The library provides production-ready utilities for parsing SSE (Server-Sent Events) streams:

| Function | Use Case |
|----------|----------|
| `parseSSEEvents` | **Testing & complete responses** - when you have the full response body |
| `parseSSEBuffer` | **Production streaming** - when data arrives incrementally in chunks |

#### parseSSEEvents

Parse a complete SSE response body into an array of events.

**When to use:** Testing with Fastify's `inject()`, or when the full response is available (e.g., request-response style SSE like OpenAI completions):

```ts
import { parseSSEEvents, type ParsedSSEEvent } from 'opinionated-machine'

const responseBody = `event: notification
data: {"id":"1","message":"Hello"}

event: notification
data: {"id":"2","message":"World"}

`

const events: ParsedSSEEvent[] = parseSSEEvents(responseBody)
// Result:
// [
//   { event: 'notification', data: '{"id":"1","message":"Hello"}' },
//   { event: 'notification', data: '{"id":"2","message":"World"}' }
// ]

// Access parsed data
const notifications = events.map(e => JSON.parse(e.data))
```

#### parseSSEBuffer

Parse a streaming SSE buffer, handling incomplete events at chunk boundaries.

**When to use:** Production clients consuming real-time SSE streams (notifications, live feeds, chat) where events arrive incrementally:

```ts
import { parseSSEBuffer, type ParseSSEBufferResult } from 'opinionated-machine'

let buffer = ''

// As chunks arrive from a stream...
for await (const chunk of stream) {
  buffer += chunk
  const result: ParseSSEBufferResult = parseSSEBuffer(buffer)

  // Process complete events
  for (const event of result.events) {
    console.log('Received:', event.event, event.data)
  }

  // Keep incomplete data for next chunk
  buffer = result.remaining
}
```

**Production example with fetch:**

```ts
const response = await fetch(url)
const reader = response.body!.getReader()
const decoder = new TextDecoder()
let buffer = ''

while (true) {
  const { done, value } = await reader.read()
  if (done) break

  buffer += decoder.decode(value, { stream: true })
  const { events, remaining } = parseSSEBuffer(buffer)
  buffer = remaining

  for (const event of events) {
    console.log('Received:', event.event, JSON.parse(event.data))
  }
}
```

#### ParsedSSEEvent Type

Both functions return events with this structure:

```ts
type ParsedSSEEvent = {
  id?: string      // Event ID (from "id:" field)
  event?: string   // Event type (from "event:" field)
  data: string     // Event data (from "data:" field, always present)
  retry?: number   // Reconnection interval (from "retry:" field)
}
```

### Testing SSE Controllers

Enable the connection spy for testing by passing `isTestMode: true` in diOptions:

```ts
import { createContainer } from 'awilix'
import { DIContext, SSETestServer, SSEHttpClient } from 'opinionated-machine'

describe('NotificationsSSEController', () => {
  let server: SSETestServer
  let controller: NotificationsSSEController

  beforeEach(async () => {
    // Create test server with isTestMode enabled
    server = await SSETestServer.create(
      async (app) => {
        // Register your SSE routes here
      },
      {
        setup: async () => {
          // Set up DI container and resources
          return { context }
        },
      }
    )

    controller = server.resources.context.diContainer.cradle.notificationsSSEController
  })

  afterEach(async () => {
    await server.resources.context.destroy()
    await server.close()
  })

  it('receives notifications over SSE', async () => {
    // Connect with awaitServerConnection to eliminate race condition
    const { client, serverConnection } = await SSEHttpClient.connect(
      server.baseUrl,
      '/api/notifications/stream',
      {
        query: { userId: 'test-user' },
        awaitServerConnection: { controller },
      },
    )

    expect(client.response.ok).toBe(true)

    // Start collecting events
    const eventsPromise = client.collectEvents(2)

    // Send events from server (serverConnection is ready immediately)
    await controller.sendEvent(serverConnection.id, {
      event: 'notification',
      data: { id: '1', message: 'Hello!' },
    })

    await controller.sendEvent(serverConnection.id, {
      event: 'notification',
      data: { id: '2', message: 'World!' },
    })

    // Wait for events
    const events = await eventsPromise

    expect(events).toHaveLength(2)
    expect(JSON.parse(events[0].data)).toEqual({ id: '1', message: 'Hello!' })
    expect(JSON.parse(events[1].data)).toEqual({ id: '2', message: 'World!' })

    // Clean up
    client.close()
  })
})
```

### SSEConnectionSpy API

The `connectionSpy` is available when `isTestMode: true` is passed to `asSSEControllerClass`:

```ts
// Wait for a connection to be established (with timeout)
const connection = await controller.connectionSpy.waitForConnection({ timeout: 5000 })

// Wait for a connection matching a predicate (useful for multiple connections)
const connection = await controller.connectionSpy.waitForConnection({
  timeout: 5000,
  predicate: (conn) => conn.request.url.includes('/api/notifications'),
})

// Check if a specific connection is active
const isConnected = controller.connectionSpy.isConnected(connectionId)

// Wait for a specific connection to disconnect
await controller.connectionSpy.waitForDisconnection(connectionId, { timeout: 5000 })

// Get all connection events (connect/disconnect history)
const events = controller.connectionSpy.getEvents()

// Clear event history and claimed connections between tests
controller.connectionSpy.clear()
```

**Note**: `waitForConnection` tracks "claimed" connections internally. Each call returns a unique unclaimed connection, allowing sequential waits for the same URL path without returning the same connection twice. This is used internally by `SSEHttpClient.connect()` with `awaitServerConnection`.

### Connection Monitoring

Controllers have access to utility methods for monitoring connections:

```ts
// Get count of active connections
const count = this.getConnectionCount()

// Get all active connections (for iteration/inspection)
const connections = this.getConnections()

// Check if connection spy is enabled (useful for conditional logic)
if (this.hasConnectionSpy()) {
  // ...
}
```

### SSE Test Utilities

The library provides utilities for testing SSE endpoints.

**Two connection methods:**
- **Inject** - Uses Fastify's built-in `inject()` to simulate HTTP requests directly in-memory, without network overhead. No `listen()` required. Handler must close the connection for the request to complete.
- **Real HTTP** - Actual HTTP connection via `fetch()`. Requires the server to be listening. Supports long-lived connections.

#### Quick Reference

| Utility | Connection | Requires Contract | Use Case |
|---------|------------|-------------------|----------|
| `SSEInjectClient` | Inject (in-memory) | No | Request-response SSE without contracts |
| `injectSSE` / `injectPayloadSSE` | Inject (in-memory) | **Yes** | Request-response SSE with type-safe contracts |
| `SSEHttpClient` | Real HTTP | No | Long-lived SSE connections |

`SSEInjectClient` and `injectSSE`/`injectPayloadSSE` do the same thing (Fastify inject), but `injectSSE`/`injectPayloadSSE` provide type safety via contracts while `SSEInjectClient` works with raw URLs.

#### Inject vs HTTP Comparison

| Feature | Inject (`SSEInjectClient`, `injectSSE`) | HTTP (`SSEHttpClient`) |
|---------|----------------------------------------|------------------------|
| **Connection** | Fastify's `inject()` - in-memory | Real HTTP via `fetch()` |
| **Event delivery** | All events returned at once (after handler closes) | Events arrive incrementally |
| **Connection lifecycle** | Handler must close for request to complete | Can stay open indefinitely |
| **Server requirement** | No `listen()` needed | Requires running server |
| **Best for** | OpenAI-style streaming, batch exports | Notifications, live feeds, chat |

#### SSETestServer

Creates a test server with `@fastify/sse` pre-configured:

```ts
import { SSETestServer, SSEHttpClient } from 'opinionated-machine'

// Basic usage
const server = await SSETestServer.create(async (app) => {
  app.get('/api/events', async (request, reply) => {
    reply.sse({ event: 'message', data: { hello: 'world' } })
    reply.sseClose()
  })
})

// Connect and test
const client = await SSEHttpClient.connect(server.baseUrl, '/api/events')
const events = await client.collectEvents(1)
expect(events[0].event).toBe('message')

// Cleanup
client.close()
await server.close()
```

With custom resources (DI container, controllers):

```ts
const server = await SSETestServer.create(
  async (app) => {
    // Register routes using resources from setup
    myController.registerRoutes(app)
  },
  {
    configureApp: async (app) => {
      app.setValidatorCompiler(validatorCompiler)
    },
    setup: async () => {
      // Resources are available via server.resources
      const container = createContainer()
      return { container }
    },
  }
)

const { container } = server.resources
```

#### SSEHttpClient

For testing long-lived SSE connections using real HTTP:

```ts
import { SSEHttpClient } from 'opinionated-machine'

// Connect to SSE endpoint with awaitServerConnection (recommended)
// This eliminates the race condition between client connect and server-side registration
const { client, serverConnection } = await SSEHttpClient.connect(
  server.baseUrl,
  '/api/stream',
  {
    query: { userId: 'test' },
    headers: { authorization: 'Bearer token' },
    awaitServerConnection: { controller }, // Pass your SSE controller
  },
)

// serverConnection is ready to use immediately
expect(client.response.ok).toBe(true)
await controller.sendEvent(serverConnection.id, { event: 'test', data: {} })

// Collect events by count with timeout
const events = await client.collectEvents(3, 5000) // 3 events, 5s timeout

// Or collect until a predicate is satisfied
const events = await client.collectEvents(
  (event) => event.event === 'done',
  5000,
)

// Iterate over events as they arrive
for await (const event of client.events()) {
  console.log(event.event, event.data)
  if (event.event === 'done') break
}

// Cleanup
client.close()
```

**`collectEvents(countOrPredicate, timeout?)`**

Collects events until a count is reached or a predicate returns true.

| Parameter | Type | Description |
|-----------|------|-------------|
| `countOrPredicate` | `number \| (event) => boolean` | Number of events to collect, or predicate that returns `true` when collection should stop |
| `timeout` | `number` | Maximum time to wait in milliseconds (default: 5000) |

Returns `Promise<ParsedSSEEvent[]>`. Throws an error if the timeout is reached before the condition is met.

```ts
// Collect exactly 3 events
const events = await client.collectEvents(3)

// Collect with custom timeout
const events = await client.collectEvents(5, 10000) // 10s timeout

// Collect until a specific event type (the matching event IS included)
const events = await client.collectEvents((event) => event.event === 'done')

// Collect until condition with timeout
const events = await client.collectEvents(
  (event) => JSON.parse(event.data).status === 'complete',
  30000,
)
```

**`events(signal?)`**

Async generator that yields events as they arrive. Accepts an optional `AbortSignal` for cancellation.

```ts
// Basic iteration
for await (const event of client.events()) {
  console.log(event.event, event.data)
  if (event.event === 'done') break
}

// With abort signal for timeout control
const controller = new AbortController()
const timeoutId = setTimeout(() => controller.abort(), 5000)

try {
  for await (const event of client.events(controller.signal)) {
    console.log(event)
  }
} finally {
  clearTimeout(timeoutId)
}
```

**When to omit `awaitServerConnection`**

Omit `awaitServerConnection` only in these cases:
- Testing against external SSE endpoints (not your own controller)
- When `isTestMode: false` (connectionSpy not available)
- Simple smoke tests that only verify response headers/status without sending server events

**Consequence**: Without `awaitServerConnection`, `connect()` resolves as soon as HTTP headers are received. Server-side connection registration may not have completed yet, so you cannot reliably send events from the server immediately after `connect()` returns.

```ts
// Example: smoke test that only checks connection works
const client = await SSEHttpClient.connect(server.baseUrl, '/api/stream')
expect(client.response.ok).toBe(true)
expect(client.response.headers.get('content-type')).toContain('text/event-stream')
client.close()
```

#### SSEInjectClient

For testing request-response style SSE streams (like OpenAI completions):

```ts
import { SSEInjectClient } from 'opinionated-machine'

const client = new SSEInjectClient(app) // No server.listen() needed

// GET request
const conn = await client.connect('/api/export/progress', {
  headers: { authorization: 'Bearer token' },
})

// POST request with body (OpenAI-style)
const conn = await client.connectWithBody(
  '/api/chat/completions',
  { model: 'gpt-4', messages: [...], stream: true },
)

// All events are available immediately (inject waits for complete response)
expect(conn.getStatusCode()).toBe(200)
const events = conn.getReceivedEvents()
const chunks = events.filter(e => e.event === 'chunk')
```

#### Contract-Aware Inject Helpers

For typed testing with SSE contracts:

```ts
import { injectSSE, injectPayloadSSE, parseSSEEvents } from 'opinionated-machine'

// For GET SSE endpoints with contracts
const { closed } = injectSSE(app, notificationsContract, {
  query: { userId: 'test' },
})
const result = await closed
const events = parseSSEEvents(result.body)

// For POST/PUT/PATCH SSE endpoints with contracts
const { closed } = injectPayloadSSE(app, chatCompletionContract, {
  body: { message: 'Hello', stream: true },
})
const result = await closed
const events = parseSSEEvents(result.body)
```

## Dual-Mode Controllers (SSE + JSON)

Dual-mode controllers handle both SSE streaming and JSON responses on the same route path, automatically branching based on the `Accept` header. This is ideal for APIs that support both real-time streaming and traditional request-response patterns.

### Overview

| Accept Header | Response Mode |
| ------------- | ------------- |
| `text/event-stream` | SSE streaming |
| `application/json` | JSON response |
| `*/*` or missing | JSON (default, configurable) |

Dual-mode controllers extend `AbstractDualModeController` which inherits from `AbstractSSEController`, providing access to all SSE features (connection management, broadcasting, lifecycle hooks) while adding JSON response support.

### Defining Dual-Mode Contracts

Dual-mode contracts define endpoints that can return **either** a complete JSON response **or** stream SSE events, based on the client's `Accept` header. Use dual-mode when:

- Clients may want immediate results (JSON) or real-time updates (SSE)
- You're building OpenAI-style APIs where `stream: true` triggers SSE
- You need polling fallback for clients that don't support SSE

To create a dual-mode contract, include a `syncResponse` schema in your `buildContract` call:
- Has `syncResponse` but no `body` → GET dual-mode route
- Has both `syncResponse` and `body` → POST/PUT/PATCH dual-mode route

```ts
import { z } from 'zod'
import { buildContract } from 'opinionated-machine'

// GET dual-mode route (polling or streaming job status) - has syncResponse, no body
export const jobStatusContract = buildContract({
  pathResolver: (params) => `/api/jobs/${params.jobId}/status`,
  params: z.object({ jobId: z.string().uuid() }),
  query: z.object({ verbose: z.string().optional() }),
  requestHeaders: z.object({}),
  syncResponse: z.object({
    status: z.enum(['pending', 'running', 'completed', 'failed']),
    progress: z.number(),
    result: z.string().optional(),
  }),
  events: {
    progress: z.object({ percent: z.number(), message: z.string().optional() }),
    done: z.object({ result: z.string() }),
  },
})

// POST dual-mode route (OpenAI-style chat completion) - has both syncResponse and body
export const chatCompletionContract = buildContract({
  method: 'POST',
  pathResolver: (params) => `/api/chats/${params.chatId}/completions`,
  params: z.object({ chatId: z.string().uuid() }),
  query: z.object({}),
  requestHeaders: z.object({ authorization: z.string() }),
  body: z.object({ message: z.string() }),
  syncResponse: z.object({
    reply: z.string(),
    usage: z.object({ tokens: z.number() }),
  }),
  events: {
    chunk: z.object({ delta: z.string() }),
    done: z.object({ usage: z.object({ total: z.number() }) }),
  },
})
```

**Note**: Dual-mode contracts use `pathResolver` instead of static `path` for type-safe path construction. The `pathResolver` function receives typed params and returns the URL path.

### Response Headers (JSON Mode)

Dual-mode contracts support an optional `responseHeaders` schema to define and validate headers sent with JSON responses. This is useful for documenting expected headers (rate limits, pagination, cache control) and validating that your handlers set them correctly:

```ts
export const rateLimitedContract = buildContract({
  method: 'POST',
  pathResolver: () => '/api/rate-limited',
  params: z.object({}),
  query: z.object({}),
  requestHeaders: z.object({}),
  body: z.object({ data: z.string() }),
  syncResponse: z.object({ result: z.string() }),
  // Define expected response headers
  responseHeaders: z.object({
    'x-ratelimit-limit': z.string(),
    'x-ratelimit-remaining': z.string(),
    'x-ratelimit-reset': z.string(),
  }),
  events: {
    result: z.object({ success: z.boolean() }),
  },
})
```

In your handler, set headers using `reply.header()`:

```ts
handlers: {
  json: async (request, reply) => {
    reply.header('x-ratelimit-limit', '100')
    reply.header('x-ratelimit-remaining', '99')
    reply.header('x-ratelimit-reset', '1640000000')
    return { result: 'success' }
  },
  sse: async (request, connection) => { /* ... */ },
}
```

If the handler doesn't set the required headers, validation will fail with a `RESPONSE_HEADERS_VALIDATION_FAILED` error.

### Implementing Dual-Mode Controllers

Dual-mode controllers use `buildHandler` to define both JSON and SSE handlers:

```ts
import {
  AbstractDualModeController,
  buildHandler,
  type BuildFastifyDualModeRoutesReturnType,
  type DualModeControllerConfig,
} from 'opinionated-machine'

type Contracts = {
  chatCompletion: typeof chatCompletionContract
}

type Dependencies = {
  aiService: AIService
}

export class ChatDualModeController extends AbstractDualModeController<Contracts> {
  public static contracts = {
    chatCompletion: chatCompletionContract,
  } as const

  private readonly aiService: AIService

  constructor(deps: Dependencies, config?: DualModeControllerConfig) {
    super(deps, config)
    this.aiService = deps.aiService
  }

  public buildDualModeRoutes(): BuildFastifyDualModeRoutesReturnType<Contracts> {
    return {
      chatCompletion: {
        contract: ChatDualModeController.contracts.chatCompletion,
        handlers: buildHandler(chatCompletionContract, {
          // JSON mode - return complete response
          json: async (request) => {
            const result = await this.aiService.complete(request.body.message)
            return {
              reply: result.text,
              usage: { tokens: result.tokenCount },
            }
          },
          // SSE mode - stream response chunks
          sse: async (request, connection) => {
            let totalTokens = 0
            for await (const chunk of this.aiService.stream(request.body.message)) {
              await connection.send('chunk', { delta: chunk.text })
              totalTokens += chunk.tokenCount ?? 0
            }
            await connection.send('done', { usage: { total: totalTokens } })
            this.closeConnection(connection.id)
          },
        }),
        options: {
          // Optional: set SSE as default mode (instead of JSON)
          defaultMode: 'sse',
          // Optional: route-level authentication
          preHandler: (request, reply) => {
            if (!request.headers.authorization) {
              return Promise.resolve(reply.code(401).send({ error: 'Unauthorized' }))
            }
          },
          // Optional: SSE lifecycle hooks
          onConnect: (conn) => console.log('Client connected:', conn.id),
          onDisconnect: (conn) => console.log('Client disconnected:', conn.id),
        },
      },
    }
  }
}
```

**Handler Signatures:**

| Mode | Signature |
| ---- | --------- |
| `json` | `(request, reply) => Response` |
| `sse` | `(request, connection) => void` |

The `json` handler must return a value matching `syncResponse` schema. The `sse` handler uses `connection.send()` for type-safe event streaming.

### Registering Dual-Mode Controllers

Use `asDualModeControllerClass` in your module:

```ts
import {
  AbstractModule,
  asControllerClass,
  asDualModeControllerClass,
  asServiceClass,
} from 'opinionated-machine'

export class ChatModule extends AbstractModule<Dependencies> {
  resolveDependencies() {
    return {
      aiService: asServiceClass(AIService),
    }
  }

  resolveControllers(diOptions: DependencyInjectionOptions) {
    return {
      // REST controller
      usersController: asControllerClass(UsersController),
      // Dual-mode controller (auto-detected via isDualModeController flag)
      chatController: asDualModeControllerClass(ChatDualModeController, { diOptions }),
    }
  }
}
```

Register dual-mode routes after the `@fastify/sse` plugin:

```ts
const app = fastify()
app.setValidatorCompiler(validatorCompiler)
app.setSerializerCompiler(serializerCompiler)

// Register @fastify/sse plugin
await app.register(FastifySSEPlugin)

// Register routes
context.registerRoutes(app)           // REST routes
context.registerSSERoutes(app)        // SSE-only routes
context.registerDualModeRoutes(app)   // Dual-mode routes

// Check if controllers exist before registration (optional)
if (context.hasDualModeControllers()) {
  context.registerDualModeRoutes(app)
}

await app.ready()
```

### Accept Header Routing

The `Accept` header determines response mode:

```bash
# JSON mode (complete response)
curl -X POST http://localhost:3000/api/chats/123/completions \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{"message": "Hello world"}'

# SSE mode (streaming response)
curl -X POST http://localhost:3000/api/chats/123/completions \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"message": "Hello world"}'
```

**Quality values** are supported for content negotiation:

```bash
# Prefer JSON (higher quality value)
curl -H "Accept: text/event-stream;q=0.5, application/json;q=1.0" ...

# Prefer SSE (higher quality value)
curl -H "Accept: application/json;q=0.5, text/event-stream;q=1.0" ...
```

### Testing Dual-Mode Controllers

Test both JSON and SSE modes:

```ts
import { createContainer } from 'awilix'
import { DIContext, SSETestServer, SSEInjectClient } from 'opinionated-machine'

describe('ChatDualModeController', () => {
  let server: SSETestServer
  let injectClient: SSEInjectClient

  beforeEach(async () => {
    const container = createContainer({ injectionMode: 'PROXY' })
    const context = new DIContext(container, { isTestMode: true }, {})
    context.registerDependencies({ modules: [new ChatModule()] }, undefined)

    server = await SSETestServer.create(
      (app) => {
        context.registerDualModeRoutes(app)
      },
      {
        configureApp: (app) => {
          app.setValidatorCompiler(validatorCompiler)
          app.setSerializerCompiler(serializerCompiler)
        },
        setup: () => ({ context }),
      },
    )

    injectClient = new SSEInjectClient(server.app)
  })

  afterEach(async () => {
    await server.resources.context.destroy()
    await server.close()
  })

  it('returns JSON for Accept: application/json', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/chats/550e8400-e29b-41d4-a716-446655440000/completions',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: 'Bearer token',
      },
      payload: { message: 'Hello' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('application/json')

    const body = JSON.parse(response.body)
    expect(body).toHaveProperty('reply')
    expect(body).toHaveProperty('usage')
  })

  it('streams SSE for Accept: text/event-stream', async () => {
    const conn = await injectClient.connectWithBody(
      '/api/chats/550e8400-e29b-41d4-a716-446655440000/completions',
      { message: 'Hello' },
      { headers: { authorization: 'Bearer token' } },
    )

    expect(conn.getStatusCode()).toBe(200)
    expect(conn.getHeaders()['content-type']).toContain('text/event-stream')

    const events = conn.getReceivedEvents()
    const chunks = events.filter((e) => e.event === 'chunk')
    const doneEvents = events.filter((e) => e.event === 'done')

    expect(chunks.length).toBeGreaterThan(0)
    expect(doneEvents).toHaveLength(1)
  })
})

