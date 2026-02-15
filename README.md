# opinionated-machine
Very opinionated DI framework for fastify, built on top of awilix

## Table of Contents

- [Basic usage](#basic-usage)
  - [Avoiding circular dependencies in typed cradle parameters](#avoiding-circular-dependencies-in-typed-cradle-parameters)
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
  - [SSESessionSpy API](#ssesessionspy-api)
  - [Session Monitoring](#session-monitoring)
  - [SSE Test Utilities](#sse-test-utilities)
    - [Quick Reference](#quick-reference)
    - [Inject vs HTTP Comparison](#inject-vs-http-comparison)
    - [SSETestServer](#ssetestserver)
    - [SSEHttpClient](#ssehttpclient)
    - [SSEInjectClient](#sseinjectclient)
    - [Contract-Aware Inject Helpers](#contract-aware-inject-helpers)
- [Dual-Mode Controllers (SSE + Sync)](#dual-mode-controllers-sse--sync)
  - [Overview](#overview)
  - [Defining Dual-Mode Contracts](#defining-dual-mode-contracts)
  - [Response Headers (Sync Mode)](#response-headers-sync-mode)
  - [Status-Specific Response Schemas (responseBodySchemasByStatusCode)](#status-specific-response-schemas-responsebodyschemasbystatuscode)
  - [Implementing Dual-Mode Controllers](#implementing-dual-mode-controllers)
  - [Registering Dual-Mode Controllers](#registering-dual-mode-controllers)
  - [Accept Header Routing](#accept-header-routing)
  - [Testing Dual-Mode Controllers](#testing-dual-mode-controllers)

## Basic usage

Define a module, or several modules, that will be used for resolving dependency graphs, using awilix:

```ts
import { AbstractModule, type InferModuleDependencies, asSingletonClass, asMessageQueueHandlerClass, asEnqueuedJobWorkerClass, asJobQueueClass, asControllerClass } from 'opinionated-machine'

export class MyModule extends AbstractModule {
    resolveDependencies(
        diOptions: DependencyInjectionOptions,
    ) {
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

// Dependencies are inferred from the return type of resolveDependencies()
export type ModuleDependencies = InferModuleDependencies<MyModule>
```

The `InferModuleDependencies` utility type extracts the dependency types from the resolvers returned by `resolveDependencies()`, so you don't need to maintain a separate type manually.

When a module is used as a secondary module, only resolvers marked as **public** (`asServiceClass`, `asUseCaseClass`, `asJobQueueClass`, `asEnqueuedJobQueueManagerFunction`) are exposed. Use `InferPublicModuleDependencies` to infer only the public dependencies (private ones are omitted entirely):

```ts
// Inferred as { service: Service } — private resolvers are omitted
export type MyModulePublicDependencies = InferPublicModuleDependencies<MyModule>
```

### Avoiding circular dependencies in typed cradle parameters

Because `InferModuleDependencies` is inferred from the module's own `resolveDependencies()` return type, classes and functions that reference it inside the same module could create a circular type dependency. The library handles this automatically for class-based resolvers. For function-based resolvers, use the indexed access pattern described below.

#### Class-based resolvers (recommended — works automatically)

All class-based resolver functions (`asSingletonClass`, `asServiceClass`, `asRepositoryClass`, etc.) use a `ClassValue<T>` type internally, which infers the instance type from the class's `prototype` property rather than its constructor signature. This means classes can freely reference `InferModuleDependencies` in their constructors without causing circular type dependencies:

```ts
import { AbstractModule, type InferModuleDependencies, asServiceClass, asSingletonClass } from 'opinionated-machine'

export class MyService {
  // Constructor references ModuleDependencies — no circular dependency!
  constructor({ myHelper }: ModuleDependencies) {
    // myHelper is fully typed as MyHelper
  }
}

export class MyHelper {
  process() {}
}

export class MyModule extends AbstractModule {
  resolveDependencies(diOptions: DependencyInjectionOptions) {
    return {
      myService: asServiceClass(MyService),   // ClassValue<T> breaks the cycle
      myHelper: asSingletonClass(MyHelper),
    }
  }
}

export type ModuleDependencies = InferModuleDependencies<MyModule>
```

**Prefer class-based resolvers wherever possible** — they provide full type safety with no `any` fallback and no extra annotations needed.

#### Function-based resolvers (`asSingletonFunction`)

Function-based resolvers (`asSingletonFunction`) cannot use the `ClassValue<T>` trick because functions don't have a `prototype` property that separates return type from parameter types. Use **indexed access** on `InferModuleDependencies` to type individual dependencies without triggering a circular reference:

```ts
// Inside resolveDependencies():
myHelper: asSingletonClass(MyHelper),
myService: asServiceClass(MyService),

myFactory: asSingletonFunction(
  ({ myHelper, myService }: {
    myHelper: ModuleDependencies['myHelper']
    myService: ModuleDependencies['myService']
  }) => {
    return () => myHelper.process()
  },
),

// ...

// At the bottom of the file:
export type ModuleDependencies = InferModuleDependencies<MyModule>
```

This works because TypeScript resolves indexed access types (`ModuleDependencies['myHelper']`) **lazily** — it looks up individual properties without computing the entire `ModuleDependencies` type, avoiding the cycle. Each dependency is fully typed and stays in sync with the module's resolvers automatically. No explicit return type annotation is needed.

For cross-module dependencies, use `InferPublicModuleDependencies`:

```ts
type OtherDeps = InferPublicModuleDependencies<OtherModule>

myFactory: asSingletonFunction(
  ({ externalService }: { externalService: OtherDeps['externalService'] }) => {
    return new MyFactory(externalService)
  },
),
```

**Note:** `Pick<ModuleDependencies, 'a' | 'b'>` does **not** work — `Pick` requires `keyof ModuleDependencies`, which forces TypeScript to resolve the entire type and triggers the circular reference. Each property must be accessed individually via indexed access.

**Alternative: class wrapper**

When adapting a third-party class with an incompatible constructor, `asSingletonFunction` is typically used to bridge the gap between the DI cradle and the library's API. If the adapter needs many dependencies, the indexed access syntax can become verbose. In that case, wrap the adaptation logic in a class and use `asSingletonClass` instead — the constructor can reference `ModuleDependencies` directly since `ClassValue<T>` breaks the cycle automatically:

```ts
// Third-party library — constructor is incompatible with DI cradle
import { S3Client } from '@aws-sdk/client-s3'

// With asSingletonFunction, each dep needs indexed access:
s3Client: asSingletonFunction(
  ({ config, logger }: {
    config: ModuleDependencies['config']
    logger: ModuleDependencies['logger']
  }) => {
    return new S3Client({
      region: config.awsRegion,
      credentials: { accessKeyId: config.awsAccessKey, secretAccessKey: config.awsSecretKey },
      logger,
    })
  },
),

// With a class wrapper, reference ModuleDependencies directly.
// If you need to add domain-specific methods, the wrapper becomes a full adapter:
class S3StorageAdapter {
  private readonly client: S3Client

  constructor({ config, logger }: ModuleDependencies) {
    this.client = new S3Client({
      region: config.awsRegion,
      credentials: { accessKeyId: config.awsAccessKey, secretAccessKey: config.awsSecretKey },
      logger,
    })
  }

  async upload(bucket: string, key: string, body: Buffer): Promise<string> {
    await this.client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }))
    return `https://${bucket}.s3.amazonaws.com/${key}`
  }
}

// In resolveDependencies():
s3StorageAdapter: asSingletonClass(S3StorageAdapter),

// If you just need the third-party instance as-is without adding any logic,
// use a simple container to avoid re-wrapping every method:
class S3ClientProvider {
  readonly client: S3Client

  constructor({ config, logger }: ModuleDependencies) {
    this.client = new S3Client({
      region: config.awsRegion,
      credentials: { accessKeyId: config.awsAccessKey, secretAccessKey: config.awsSecretKey },
      logger,
    })
  }
}

// In resolveDependencies():
s3ClientProvider: asSingletonClass(S3ClientProvider),

// Consumers access the original instance directly:
// this.s3ClientProvider.client.send(new PutObjectCommand({ ... }))
```

This is more heavyweight than a function resolver but provides full type safety with no indexed access needed, and scales cleanly to any number of dependencies.

You can also use the explicit generic pattern if you prefer (e.g. for `isolatedDeclarations` mode):

```ts
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
        return { /* ... */ }
    }
}
```

## Defining controllers

Controllers require using fastify-api-contracts and allow to define application routes.

```ts
import { buildFastifyRoute } from '@lokalise/fastify-api-contracts'
import { buildRestContract } from '@lokalise/api-contracts'
import { z } from 'zod/v4'
import { AbstractController } from 'opinionated-machine'

const BODY_SCHEMA = z.object({})
const PATH_PARAMS_SCHEMA = z.object({
  userId: z.string(),
})

const contract = buildRestContract({
  method: 'delete',
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

    private deleteItem = buildFastifyRoute(
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

Use `buildSseContract` from `@lokalise/api-contracts` to define SSE routes. The `method` field determines the HTTP method. Paths are defined using `pathResolver`, a type-safe function that receives typed params and returns the URL path:

```ts
import { z } from 'zod'
import { buildSseContract } from '@lokalise/api-contracts'

// GET-based SSE stream with path params
export const channelStreamContract = buildSseContract({
  method: 'get',
  pathResolver: (params) => `/api/channels/${params.channelId}/stream`,
  requestPathParamsSchema: z.object({ channelId: z.string() }),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({}),
  serverSentEventSchemas: {
    message: z.object({ content: z.string() }),
  },
})

// GET-based SSE stream without path params
export const notificationsContract = buildSseContract({
  method: 'get',
  pathResolver: () => '/api/notifications/stream',
  requestPathParamsSchema: z.object({}),
  requestQuerySchema: z.object({ userId: z.string().optional() }),
  requestHeaderSchema: z.object({}),
  serverSentEventSchemas: {
    notification: z.object({
      id: z.string(),
      message: z.string(),
    }),
  },
})

// POST-based SSE stream (e.g., AI chat completions)
export const chatCompletionContract = buildSseContract({
  method: 'post',
  pathResolver: () => '/api/chat/completions',
  requestPathParamsSchema: z.object({}),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({}),
  requestBodySchema: z.object({
    message: z.string(),
    stream: z.literal(true),
  }),
  serverSentEventSchemas: {
    chunk: z.object({ content: z.string() }),
    done: z.object({ totalTokens: z.number() }),
  },
})
```

For reusable event schema definitions, you can use the `SSEEventSchemas` type (requires TypeScript 4.9+ for `satisfies`):

```ts
import { z } from 'zod'
import type { SSEEventSchemas } from 'opinionated-machine'

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
  type SSESession
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
      notificationsStream: this.handleStream,
    }
  }

  // Handler with automatic type inference from contract
  // sse.start(mode) returns a session with type-safe event sending
  // Options (onConnect, onClose) are passed as the third parameter to buildHandler
  private handleStream = buildHandler(notificationsContract, {
    sse: async (request, sse) => {
      // request.query is typed from contract: { userId?: string }
      const userId = request.query.userId ?? 'anonymous'

      // Start streaming with 'keepAlive' mode - stays open for external events
      // Sends HTTP 200 + SSE headers immediately
      const session = sse.start('keepAlive', { context: { userId } })

      // For external triggers (subscriptions, timers, message queues), use sendEventInternal.
      // session.send is only available within this handler's scope - external callbacks
      // like subscription handlers execute later, outside this function, so they can't access session.
      // sendEventInternal is a controller method, so it's accessible from any callback.
      // It provides autocomplete for all event names defined in the controller's contracts.
      this.notificationService.subscribe(userId, async (notification) => {
        await this.sendEventInternal(session.id, {
          event: 'notification',
          data: notification,
        })
      })

      // For direct sending within the handler, use the session's send method.
      // It provides stricter per-route typing (only events from this specific contract).
      await session.send('notification', { id: 'welcome', message: 'Connected!' })

      // 'keepAlive' mode: handler returns, but connection stays open for subscription events
      // Connection closes when client disconnects or server calls closeConnection()
    },
  }, {
    onConnect: (session) => console.log('Client connected:', session.id),
    onClose: (session, reason) => {
      const userId = session.context?.userId as string
      this.notificationService.unsubscribe(userId)
      console.log(`Client disconnected (${reason}):`, session.id)
    },
  })
}
```

### Type-Safe SSE Handlers with `buildHandler`

For automatic type inference of request parameters (similar to `buildFastifyRoute` for regular controllers), use `buildHandler`:

```ts
import {
  AbstractSSEController,
  buildHandler,
  type SSEControllerConfig,
  type SSESession
} from 'opinionated-machine'

class ChatSSEController extends AbstractSSEController<Contracts> {
  public static contracts = {
    chatCompletion: chatCompletionContract,
  } as const

  constructor(deps: Dependencies, sseConfig?: SSEControllerConfig) {
    super(deps, sseConfig)
  }

  // Handler with automatic type inference from contract
  // sse.start(mode) returns session with fully typed send()
  private handleChatCompletion = buildHandler(chatCompletionContract, {
    sse: async (request, sse) => {
      // request.body is typed as { message: string; stream: true }
      // request.query, request.params, request.headers all typed from contract
      const words = request.body.message.split(' ')

      // Start streaming with 'autoClose' mode - closes after handler completes
      // Sends HTTP 200 + SSE headers immediately
      const session = sse.start('autoClose')

      for (const word of words) {
        // session.send() provides compile-time type checking for event names and data
        await session.send('chunk', { content: word })
      }

      // 'autoClose' mode: connection closes automatically when handler returns
    },
  })

  public buildSSERoutes() {
    return {
      chatCompletion: this.handleChatCompletion,
    }
  }
}
```

You can also use `InferSSERequest<Contract>` for manual type annotation when needed:

```ts
import { type InferSSERequest, type SSEContext, type SSESession } from 'opinionated-machine'

private handleStream = async (
  request: InferSSERequest<typeof chatCompletionContract>,
  sse: SSEContext<typeof chatCompletionContract['serverSentEventSchemas']>,
) => {
  // request.body, request.params, etc. all typed from contract
  const session = sse.start('autoClose')
  // session.send() is typed based on contract serverSentEventSchemas
  await session.send('chunk', { content: 'hello' })
  // 'autoClose' mode: connection closes when handler returns
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
import { AbstractModule, type InferModuleDependencies, asControllerClass, asSSEControllerClass, asServiceClass, type DependencyInjectionOptions } from 'opinionated-machine'

export class NotificationsModule extends AbstractModule {
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

export type NotificationsModuleDependencies = InferModuleDependencies<NotificationsModule>
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

// Broadcast to sessions matching a predicate
await this.broadcastIf(
  { event: 'channel-update', data: { channelId: '123', newMessage: msg } },
  (session) => session.context.channelId === '123',
)
```

Both methods return the number of clients the message was successfully sent to.

### Controller-Level Hooks

Override these optional methods on your controller for global session handling:

```ts
class MySSEController extends AbstractSSEController<Contracts> {
  // Called AFTER session is registered (for all routes)
  protected onConnectionEstablished(session: SSESession): void {
    this.metrics.incrementConnections()
  }

  // Called BEFORE session is unregistered (for all routes)
  protected onConnectionClosed(session: SSESession): void {
    this.metrics.decrementConnections()
  }
}
```

### Route-Level Options

Each route can have its own `preHandler`, lifecycle hooks, and logger. Pass these as the third parameter to `buildHandler`:

```ts
public buildSSERoutes() {
  return {
    adminStream: this.handleAdminStream,
  }
}

private handleAdminStream = buildHandler(adminStreamContract, {
  sse: async (request, sse) => {
    const session = sse.start('keepAlive')
    // ... handler logic
  },
}, {
  // Route-specific authentication
  preHandler: (request, reply) => {
    if (!request.user?.isAdmin) {
      reply.code(403).send({ error: 'Forbidden' })
    }
  },
  onConnect: (session) => console.log('Admin connected'),
  onClose: (session, reason) => console.log(`Admin disconnected (${reason})`),
  // Handle client reconnection with Last-Event-ID
  onReconnect: async (session, lastEventId) => {
    // Return events to replay, or handle manually
    return this.getEventsSince(lastEventId)
  },
  // Optional: logger for error handling (requires @lokalise/node-core)
  logger: this.logger,
})
```

**Available route options:**

| Option | Description |
| -------- | ------------- |
| `preHandler` | Authentication/authorization hook that runs before SSE session |
| `onConnect` | Called after client connects (SSE handshake complete) |
| `onClose` | Called when session closes (client disconnect, network failure, or server close). Receives `(session, reason)` where reason is `'server'` or `'client'` |
| `onReconnect` | Handle Last-Event-ID reconnection, return events to replay |
| `logger` | Optional `SSELogger` for error handling (compatible with pino and `@lokalise/node-core`). If not provided, errors in lifecycle hooks are silently ignored |
| `serializer` | Custom serializer for SSE data (e.g., for custom JSON encoding) |
| `heartbeatInterval` | Interval in ms for heartbeat keep-alive messages |

**onClose reason parameter:**
- `'server'`: Server explicitly closed the session (via `closeConnection()` or `autoClose` mode)
- `'client'`: Client closed the session (EventSource.close(), navigation, network failure)

```ts
options: {
  onConnect: (session) => console.log('Client connected'),
  onClose: (session, reason) => {
    console.log(`Session closed (${reason}):`, session.id)
    // reason is 'server' or 'client'
  },
  serializer: (data) => JSON.stringify(data, null, 2), // Pretty-print JSON
  heartbeatInterval: 30000, // Send heartbeat every 30 seconds
}
```

### SSE Session Methods

The `session` object returned by `sse.start(mode)` provides several useful methods:

```ts
private handleStream = buildHandler(streamContract, {
  sse: async (request, sse) => {
    const session = sse.start('autoClose')

    // Check if session is still active
    if (session.isConnected()) {
      await session.send('status', { connected: true })
    }

    // Get raw writable stream for advanced use cases (e.g., pipeline)
    const stream = session.getStream()

    // Stream messages from an async iterable with automatic validation
    async function* generateMessages() {
      yield { event: 'message' as const, data: { text: 'Hello' } }
      yield { event: 'message' as const, data: { text: 'World' } }
    }
    await session.sendStream(generateMessages())

    // 'autoClose' mode: connection closes when handler returns
  },
})
```

| Method | Description |
| -------- | ------------- |
| `send(event, data, options?)` | Send a typed event (validates against contract schema) |
| `isConnected()` | Check if the session is still active |
| `getStream()` | Get the underlying `WritableStream` for advanced use cases |
| `sendStream(messages)` | Stream messages from an `AsyncIterable` with validation |

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

**Lifecycle hook errors** (`onConnect`, `onReconnect`, `onClose`):
- All lifecycle hooks are wrapped in try/catch to prevent crashes
- If a `logger` is provided in route options, errors are logged with context
- If no logger is provided, errors are silently ignored
- The session lifecycle continues even if a hook throws

```ts
// Provide a logger to capture lifecycle errors
public buildSSERoutes() {
  return {
    stream: this.handleStream,
  }
}

private handleStream = buildHandler(streamContract, {
  sse: async (request, sse) => {
    const session = sse.start('autoClose')
    // ... handler logic
  },
}, {
  logger: this.logger, // pino-compatible logger
  onConnect: (session) => { /* may throw */ },
  onClose: (session, reason) => { /* may throw */ },
})
```

### Long-lived Connections vs Request-Response Streaming

SSE session lifetime is determined by the mode passed to `sse.start(mode)`:

```ts
// sse.start('autoClose') - close connection when handler returns (request-response pattern)
// sse.start('keepAlive') - keep connection open for external events (subscription pattern)
// sse.respond(code, body) - send HTTP response before streaming (early return)
```

**Long-lived sessions** (notifications, live updates):
- Handler starts streaming with `sse.start('keepAlive')`
- Session stays open indefinitely after handler returns
- Events are sent later via callbacks using `sendEventInternal()`
- **Client closes session** when done (e.g., `eventSource.close()` or navigating away)
- Server cleans up via `onConnectionClosed()` hook

```ts
private handleStream = buildHandler(streamContract, {
  sse: async (request, sse) => {
    // Start streaming with 'keepAlive' mode - stays open for external events
    const session = sse.start('keepAlive')

    // Set up subscription - events sent via callback AFTER handler returns
    this.service.subscribe(session.id, (data) => {
      this.sendEventInternal(session.id, { event: 'update', data })
    })
    // 'keepAlive' mode: handler returns, but connection stays open
  },
})

// Clean up when client disconnects
protected onConnectionClosed(session: SSESession): void {
  this.service.unsubscribe(session.id)
}
```

**Request-response streaming** (AI completions):
- Handler starts streaming with `sse.start('autoClose')`
- Use `session.send()` for type-safe event sending within the handler
- Session automatically closes when handler returns

```ts
private handleChatCompletion = buildHandler(chatCompletionContract, {
  sse: async (request, sse) => {
    // Start streaming with 'autoClose' mode - closes when handler returns
    const session = sse.start('autoClose')

    const words = request.body.message.split(' ')
    for (const word of words) {
      await session.send('chunk', { content: word })
    }
    await session.send('done', { totalTokens: words.length })

    // 'autoClose' mode: connection closes automatically when handler returns
  },
})
```

**Error handling before streaming:**

Use `sse.respond(code, body)` to return an HTTP response before streaming starts. This is useful for any early return: validation errors, not found, redirects, etc.

```ts
private handleStream = buildHandler(streamContract, {
  sse: async (request, sse) => {
    // Early return BEFORE starting stream - can return any HTTP response
    const entity = await this.service.find(request.params.id)
    if (!entity) {
      return sse.respond(404, { error: 'Entity not found' })
    }

    // Validation passed - start streaming with autoClose mode
    const session = sse.start('autoClose')
    await session.send('data', entity)
    // Connection closes automatically when handler returns
  },
})

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

### SSESessionSpy API

The `connectionSpy` is available when `isTestMode: true` is passed to `asSSEControllerClass`:

```ts
// Wait for a session to be established (with timeout)
const session = await controller.connectionSpy.waitForConnection({ timeout: 5000 })

// Wait for a session matching a predicate (useful for multiple sessions)
const session = await controller.connectionSpy.waitForConnection({
  timeout: 5000,
  predicate: (s) => s.request.url.includes('/api/notifications'),
})

// Check if a specific session is active
const isConnected = controller.connectionSpy.isConnected(sessionId)

// Wait for a specific session to disconnect
await controller.connectionSpy.waitForDisconnection(sessionId, { timeout: 5000 })

// Get all session events (connect/disconnect history)
const events = controller.connectionSpy.getEvents()

// Clear event history and claimed sessions between tests
controller.connectionSpy.clear()
```

**Note**: `waitForConnection` tracks "claimed" sessions internally. Each call returns a unique unclaimed session, allowing sequential waits for the same URL path without returning the same session twice. This is used internally by `SSEHttpClient.connect()` with `awaitServerConnection`.

### Session Monitoring

Controllers have access to utility methods for monitoring sessions:

```ts
// Get count of active sessions
const count = this.getConnectionCount()

// Get all active sessions (for iteration/inspection)
const sessions = this.getConnections()

// Check if session spy is enabled (useful for conditional logic)
if (this.hasConnectionSpy()) {
  // ...
}
```

### SSE Test Utilities

The library provides utilities for testing SSE endpoints.

**Two transport methods:**
- **Inject** - Uses Fastify's built-in `inject()` to simulate HTTP requests directly in-memory, without network overhead. No `listen()` required. Handler must close the session for the request to complete.
- **Real HTTP** - Actual HTTP via `fetch()`. Requires the server to be listening. Supports long-lived sessions.

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
    reply.sse.close()
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

## Dual-Mode Controllers (SSE + Sync)

Dual-mode controllers handle both SSE streaming and sync responses on the same route path, automatically branching based on the `Accept` header. This is ideal for APIs that support both real-time streaming and traditional request-response patterns.

### Overview

| Accept Header | Response Mode |
| ------------- | ------------- |
| `text/event-stream` | SSE streaming |
| `application/json` | Sync response |
| `*/*` or missing | Sync (default, configurable) |

Dual-mode controllers extend `AbstractDualModeController` which inherits from `AbstractSSEController`, providing access to all SSE features (connection management, broadcasting, lifecycle hooks) while adding sync response support.

### Defining Dual-Mode Contracts

Dual-mode contracts define endpoints that can return **either** a complete sync response **or** stream SSE events, based on the client's `Accept` header. Use dual-mode when:

- Clients may want immediate results (sync) or real-time updates (SSE)
- You're building OpenAI-style APIs where `stream: true` triggers SSE
- You need polling fallback for clients that don't support SSE

To create a dual-mode contract, include a `successResponseBodySchema` in your `buildSseContract` call:
- Has `successResponseBodySchema` but no `requestBodySchema` → GET dual-mode route
- Has both `successResponseBodySchema` and `requestBodySchema` → POST/PUT/PATCH dual-mode route

```ts
import { z } from 'zod'
import { buildSseContract } from '@lokalise/api-contracts'

// GET dual-mode route (polling or streaming job status)
export const jobStatusContract = buildSseContract({
  method: 'get',
  pathResolver: (params) => `/api/jobs/${params.jobId}/status`,
  requestPathParamsSchema: z.object({ jobId: z.string().uuid() }),
  requestQuerySchema: z.object({ verbose: z.string().optional() }),
  requestHeaderSchema: z.object({}),
  successResponseBodySchema: z.object({
    status: z.enum(['pending', 'running', 'completed', 'failed']),
    progress: z.number(),
    result: z.string().optional(),
  }),
  serverSentEventSchemas: {
    progress: z.object({ percent: z.number(), message: z.string().optional() }),
    done: z.object({ result: z.string() }),
  },
})

// POST dual-mode route (OpenAI-style chat completion)
export const chatCompletionContract = buildSseContract({
  method: 'post',
  pathResolver: (params) => `/api/chats/${params.chatId}/completions`,
  requestPathParamsSchema: z.object({ chatId: z.string().uuid() }),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({ authorization: z.string() }),
  requestBodySchema: z.object({ message: z.string() }),
  successResponseBodySchema: z.object({
    reply: z.string(),
    usage: z.object({ tokens: z.number() }),
  }),
  serverSentEventSchemas: {
    chunk: z.object({ delta: z.string() }),
    done: z.object({ usage: z.object({ total: z.number() }) }),
  },
})
```

**Note**: Dual-mode contracts use `pathResolver` instead of static `path` for type-safe path construction. The `pathResolver` function receives typed params and returns the URL path.

### Response Headers (Sync Mode)

Dual-mode contracts support an optional `responseHeaderSchema` to define and validate headers sent with sync responses. This is useful for documenting expected headers (rate limits, pagination, cache control) and validating that your handlers set them correctly:

```ts
export const rateLimitedContract = buildSseContract({
  method: 'post',
  pathResolver: () => '/api/rate-limited',
  requestPathParamsSchema: z.object({}),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({}),
  requestBodySchema: z.object({ data: z.string() }),
  successResponseBodySchema: z.object({ result: z.string() }),
  // Define expected response headers
  responseHeaderSchema: z.object({
    'x-ratelimit-limit': z.string(),
    'x-ratelimit-remaining': z.string(),
    'x-ratelimit-reset': z.string(),
  }),
  serverSentEventSchemas: {
    result: z.object({ success: z.boolean() }),
  },
})
```

In your handler, set headers using `reply.header()`:

```ts
handlers: buildHandler(rateLimitedContract, {
  sync: async (request, reply) => {
    reply.header('x-ratelimit-limit', '100')
    reply.header('x-ratelimit-remaining', '99')
    reply.header('x-ratelimit-reset', '1640000000')
    return { result: 'success' }
  },
  sse: async (request, sse) => {
    const session = sse.start('autoClose')
    // ... send events ...
    // Connection closes automatically when handler returns
  },
})
```

If the handler doesn't set the required headers, validation will fail with a `RESPONSE_HEADERS_VALIDATION_FAILED` error.

### Status-Specific Response Schemas (responseBodySchemasByStatusCode)

Dual-mode and SSE contracts support `responseBodySchemasByStatusCode` to define and validate responses for specific HTTP status codes. This is typically used for error responses (4xx, 5xx), but can define schemas for any status code where you need a different response shape:

```ts
export const resourceContract = buildSseContract({
  method: 'post',
  pathResolver: (params) => `/api/resources/${params.id}`,
  requestPathParamsSchema: z.object({ id: z.string() }),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({}),
  requestBodySchema: z.object({ data: z.string() }),
  // Success response (2xx)
  successResponseBodySchema: z.object({
    success: z.boolean(),
    data: z.string(),
  }),
  // Responses by status code (typically used for errors)
  responseBodySchemasByStatusCode: {
    400: z.object({ error: z.string(), details: z.array(z.string()) }),
    404: z.object({ error: z.string(), resourceId: z.string() }),
  },
  serverSentEventSchemas: {
    result: z.object({ success: z.boolean() }),
  },
})
```

**Recommended: Use `sse.respond()` for strict type safety**

In SSE handlers, use `sse.respond(code, body)` for non-2xx responses. This provides strict compile-time type enforcement - TypeScript ensures the body matches the exact schema for that status code:

```ts
handlers: buildHandler(resourceContract, {
  sync: (request, reply) => {
    if (!isValid(request.body.data)) {
      reply.code(400)
      return { error: 'Bad Request', details: ['Invalid data format'] }
    }
    return { success: true, data: 'OK' }
  },
  sse: async (request, sse) => {
    const resource = findResource(request.params.id)
    if (!resource) {
      // Strict typing: TypeScript enforces exact schema for status 404
      return sse.respond(404, { error: 'Not Found', resourceId: request.params.id })
    }
    if (!isValid(resource)) {
      // Strict typing: TypeScript enforces exact schema for status 400
      return sse.respond(400, { error: 'Bad Request', details: ['Invalid resource'] })
    }

    const session = sse.start('autoClose')
    await session.send('result', { success: true })
  },
})
```

TypeScript enforces the exact schema for each status code at compile time:

```ts
sse.respond(404, { error: 'Not Found', resourceId: '123' })  // ✓ OK
sse.respond(404, { error: 'Not Found' })                     // ✗ Error - missing resourceId
sse.respond(404, { error: 'Not Found', details: [] })        // ✗ Error - wrong schema for 404
sse.respond(500, { message: 'error' })                       // ✗ Error - 500 not defined in schema
```

Only status codes defined in `responseBodySchemasByStatusCode` are allowed. To use an undefined status code, add it to the schema or use a type assertion.

**Sync handlers (union typing with runtime validation):**

For sync handlers, use `reply.code()` to set the status code and return the response. However, since `reply.code()` and `return` are separate statements, TypeScript cannot correlate them. The return type is a union of all possible response shapes, and runtime validation catches mismatches:

```ts
sync: (request, reply) => {
  reply.code(404)
  return { error: 'Not Found', resourceId: '123' }  // ✓ OK - matches one of the union types
  // Runtime validation ensures body matches the 404 schema
}

// The sync handler return type is automatically:
// { success: boolean; data: string }           // from successResponseBodySchema
// | { error: string; details: string[] }       // from responseBodySchemasByStatusCode[400]
// | { error: string; resourceId: string }      // from responseBodySchemasByStatusCode[404]
```

**Validation behavior:**

- **Success responses (2xx)**: Validated against `successResponseBodySchema`
- **Non-2xx responses**: Validated against the matching schema in `responseBodySchemasByStatusCode` (if defined)
- **Validation failures**: Return 500 Internal Server Error (validation details are logged internally, not exposed to clients)

**Validation priority for 2xx status codes:**

- All 2xx responses (200, 201, 204, etc.) are validated against `successResponseBodySchema`
- `responseBodySchemasByStatusCode` is only used for non-2xx status codes
- If you define the same 2xx code in both, `successResponseBodySchema` takes precedence

### Single Sync Handler

Dual-mode contracts use a single `sync` handler that returns the response data. The framework handles content-type negotiation automatically:

```ts
handlers: buildHandler(chatCompletionContract, {
  sync: async (request, reply) => {
    // Return the response data matching successResponseBodySchema
    const result = await aiService.complete(request.body.message)
    return {
      reply: result.text,
      usage: { tokens: result.tokenCount },
    }
  },
  sse: async (request, sse) => {
    // SSE streaming handler
    const session = sse.start('autoClose')
    // ... stream events ...
  },
})
```

TypeScript enforces the correct handler structure:
- `successResponseBodySchema` contracts must use `sync` handler (returns response data)
- `serverSentEventSchemas` contracts must use `sse` handler (streams events)

### Implementing Dual-Mode Controllers

Dual-mode controllers use `buildHandler` to define both sync and SSE handlers. The handler is returned directly from `buildDualModeRoutes`, with options passed as the third parameter to `buildHandler`:

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
      chatCompletion: this.handleChatCompletion,
    }
  }

  // Handler with options as third parameter
  private handleChatCompletion = buildHandler(chatCompletionContract, {
    // Sync mode - return complete response
    sync: async (request, _reply) => {
      const result = await this.aiService.complete(request.body.message)
      return {
        reply: result.text,
        usage: { tokens: result.tokenCount },
      }
    },
    // SSE mode - stream response chunks
    sse: async (request, sse) => {
      const session = sse.start('autoClose')
      let totalTokens = 0
      for await (const chunk of this.aiService.stream(request.body.message)) {
        await session.send('chunk', { delta: chunk.text })
        totalTokens += chunk.tokenCount ?? 0
      }
      await session.send('done', { usage: { total: totalTokens } })
      // Connection closes automatically when handler returns
    },
  }, {
    // Optional: set SSE as default mode (instead of sync)
    defaultMode: 'sse',
    // Optional: route-level authentication
    preHandler: (request, reply) => {
      if (!request.headers.authorization) {
        return Promise.resolve(reply.code(401).send({ error: 'Unauthorized' }))
      }
    },
    // Optional: SSE lifecycle hooks
    onConnect: (session) => console.log('Client connected:', session.id),
    onClose: (session, reason) => console.log(`Client disconnected (${reason}):`, session.id),
  })
}
```

**Handler Signatures:**

| Mode | Signature |
| ---- | --------- |
| `sync` | `(request, reply) => Response` |
| `sse` | `(request, sse) => SSEHandlerResult` |

The `sync` handler must return a value matching `successResponseBodySchema`. The `sse` handler uses `sse.start(mode)` to begin streaming (`'autoClose'` for request-response, `'keepAlive'` for long-lived sessions) and `session.send()` for type-safe event sending.

### Registering Dual-Mode Controllers

Use `asDualModeControllerClass` in your module:

```ts
import {
  AbstractModule,
  type InferModuleDependencies,
  asControllerClass,
  asDualModeControllerClass,
  asServiceClass,
} from 'opinionated-machine'

export class ChatModule extends AbstractModule {
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

export type ChatModuleDependencies = InferModuleDependencies<ChatModule>
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

**Subtype wildcards** are supported for flexible content negotiation:

```bash
# Accept any text format (matches text/plain, text/csv, etc.)
curl -H "Accept: text/*" ...

# Accept any application format (matches application/json, application/xml, etc.)
curl -H "Accept: application/*" ...

# Combine with quality values
curl -H "Accept: text/event-stream;q=0.9, application/*;q=0.5" ...
```

The matching priority is: `text/event-stream` (SSE) > exact matches > subtype wildcards > `*/*` > fallback.

### Testing Dual-Mode Controllers

Test both sync and SSE modes:

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

  it('returns sync response for Accept: application/json', async () => {
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

