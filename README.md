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
  - [SSE Controllers Without Dependencies](#sse-controllers-without-dependencies)
  - [Registering SSE Controllers](#registering-sse-controllers)
  - [Registering SSE Routes](#registering-sse-routes)
  - [Testing SSE Controllers](#testing-sse-controllers)
  - [SSEConnectionSpy API](#sseconnectionspy-api)
  - [Connection Monitoring](#connection-monitoring)
  - [SSE Test Utilities](#sse-test-utilities)
  - [Broadcasting Events](#broadcasting-events)
  - [Controller-Level Hooks](#controller-level-hooks)
  - [Route-Level Options](#route-level-options)
  - [Graceful Shutdown](#graceful-shutdown)
  - [Error Handling](#error-handling)
  - [Long-lived Connections vs Request-Response Streaming](#long-lived-connections-vs-request-response-streaming)

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
    resolveControllers() {
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
For controller classes. Marks the dependency as **private**. Use in `resolveControllers()`.

```ts
userController: asControllerClass(UserController)
```

#### `asSSEControllerClass(Type, sseOptions?, opts?)`
For SSE controller classes. Marks the dependency as **private**. Automatically configures `closeAllConnections` as the async dispose method for graceful shutdown. When `sseOptions.diOptions.isTestMode` is true, enables the connection spy for testing.

```ts
// Without test mode
notificationsSSEController: asSSEControllerClass(NotificationsSSEController)

// With test mode (enables connectionSpy)
notificationsSSEController: asSSEControllerClass(NotificationsSSEController, { diOptions })
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

Use `buildSSERoute` for GET-based SSE streams or `buildPayloadSSERoute` for POST/PUT/PATCH streams:

```ts
import { z } from 'zod'
import { buildSSERoute, buildPayloadSSERoute } from 'opinionated-machine'

// GET-based SSE stream (e.g., notifications)
export const notificationsContract = buildSSERoute({
  path: '/api/notifications/stream',
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

// POST-based SSE stream (e.g., AI chat completions)
export const chatCompletionContract = buildPayloadSSERoute({
  method: 'POST',
  path: '/api/chat/completions',
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

### Creating SSE Controllers

SSE controllers extend `AbstractSSEController` and must implement a two-parameter constructor:

```ts
import { AbstractSSEController, type SSEControllerConfig, type SSEConnection } from 'opinionated-machine'
import type { FastifyRequest } from 'fastify'

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
        handler: this.handleStream,
        options: {
          onConnect: (conn) => this.onConnect(conn),
          onDisconnect: (conn) => this.onDisconnect(conn),
        },
      },
    }
  }

  // Handler for incoming connections
  private handleStream = async (
    request: FastifyRequest<{ Querystring: { userId?: string } }>,
    connection: SSEConnection,
  ) => {
    const userId = request.query.userId ?? 'anonymous'
    connection.context = { userId }

    // Subscribe to notifications for this user
    this.notificationService.subscribe(userId, async (notification) => {
      await this.sendEvent(connection.id, {
        event: 'notification',
        data: notification,
      })
    })
  }

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

Use `asSSEControllerClass` in your module and implement `resolveSSEControllers`:

```ts
import { AbstractModule, asSSEControllerClass, asServiceClass } from 'opinionated-machine'

export class NotificationsModule extends AbstractModule<Dependencies> {
  resolveDependencies(diOptions: DependencyInjectionOptions) {
    return {
      notificationService: asServiceClass(NotificationService),
      notificationsSSEController: asSSEControllerClass(NotificationsSSEController, { diOptions }),
    }
  }

  resolveSSEControllers() {
    return {
      notificationsSSEController: asSSEControllerClass(NotificationsSSEController),
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

### Testing SSE Controllers

Enable the connection spy for testing by passing `isTestMode: true` in diOptions:

```ts
import { createContainer } from 'awilix'
import { DIContext, createSSETestServer, connectSSE } from 'opinionated-machine'

describe('NotificationsSSEController', () => {
  let server: SSETestServer
  let controller: NotificationsSSEController

  beforeEach(async () => {
    // Create test server with isTestMode enabled
    server = await createSSETestServer({
      modules: [new NotificationsModule()],
      diOptions: { isTestMode: true }, // Enables connectionSpy
    })

    controller = server.resources.context.diContainer.cradle.notificationsSSEController
  })

  afterEach(async () => {
    await server.resources.context.destroy()
    await server.close()
  })

  it('receives notifications over SSE', async () => {
    // Connect to SSE endpoint
    const clientConnection = await connectSSE(server.baseUrl, '/api/notifications/stream', {
      query: { userId: 'test-user' },
    })

    expect(clientConnection.response.ok).toBe(true)

    // Wait for server-side connection to be established
    const serverConnection = await controller.connectionSpy.waitForConnection()

    // Send events from server
    await controller.sendEvent(serverConnection.id, {
      event: 'notification',
      data: { id: '1', message: 'Hello!' },
    })

    await controller.sendEvent(serverConnection.id, {
      event: 'notification',
      data: { id: '2', message: 'World!' },
    })

    // Collect buffered events
    const events = await clientConnection.collectEvents(2)

    expect(events).toHaveLength(2)
    expect(JSON.parse(events[0].data)).toEqual({ id: '1', message: 'Hello!' })
    expect(JSON.parse(events[1].data)).toEqual({ id: '2', message: 'World!' })

    // Clean up
    clientConnection.close()
  })
})
```

### SSEConnectionSpy API

The `connectionSpy` is available when `isTestMode: true` is passed to `asSSEControllerClass`:

```ts
// Wait for a connection to be established (with timeout)
const connection = await controller.connectionSpy.waitForConnection({ timeout: 5000 })

// Check if a specific connection is active
const isConnected = controller.connectionSpy.isConnected(connectionId)

// Wait for a specific connection to disconnect
await controller.connectionSpy.waitForDisconnection(connectionId, { timeout: 5000 })

// Get all connection events (connect/disconnect history)
const events = controller.connectionSpy.getEvents()

// Clear event history between tests
controller.connectionSpy.clear()
```

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

The library provides utilities for testing SSE endpoints:

```ts
import { connectSSE, createSSETestServer, parseSSEEvents, injectPayloadSSE } from 'opinionated-machine'

// Create a test server with SSE support
const server = await createSSETestServer({
  modules: [new MyModule()],
  diOptions: { isTestMode: true },
})

// Connect to a GET SSE endpoint
const connection = await connectSSE(server.baseUrl, '/api/stream', {
  query: { userId: 'test' },
  headers: { authorization: 'Bearer token' },
})

// Collect events with timeout
const events = await connection.collectEvents(3, 5000) // 3 events, 5s timeout

// Or collect until a predicate is satisfied
const events = await connection.collectEvents(
  (event) => event.event === 'done',
  5000,
)

// For POST SSE endpoints, use injectPayloadSSE
const { closed } = injectPayloadSSE(app, chatCompletionContract, {
  body: { message: 'Hello', stream: true },
})
const result = await closed
const events = parseSSEEvents(result.body)
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

Each route can have its own `preHandler` and lifecycle hooks:

```ts
public buildSSERoutes() {
  return {
    adminStream: {
      contract: AdminSSEController.contracts.adminStream,
      handler: this.handleAdminStream,
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
      },
    },
  }
}
```

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

### Long-lived Connections vs Request-Response Streaming

**Long-lived connections** (notifications, live updates):
- Handler sets up subscriptions and returns
- Connection stays open until client disconnects
- Events sent via `sendEvent()` from external triggers

```ts
private handleStream = async (request, connection) => {
  // Set up subscription
  this.service.subscribe(connection.id, (data) => {
    this.sendEvent(connection.id, { event: 'update', data })
  })
  // Handler returns, connection stays open
}
```

**Request-response streaming** (AI completions):
- Handler sends all events and closes connection
- Similar to regular HTTP but with streaming body

```ts
private handleChatCompletion = async (request, connection) => {
  const words = request.body.message.split(' ')

  for (const word of words) {
    await this.sendEvent(connection.id, {
      event: 'chunk',
      data: { content: word },
    })
  }

  await this.sendEvent(connection.id, {
    event: 'done',
    data: { totalTokens: words.length },
  })

  // Close connection when done
  this.closeConnection(connection.id)
}
```

