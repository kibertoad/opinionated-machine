# opinionated-machine
Very opinionated DI framework for fastify, built on top of awilix

## Table of Contents

- [Basic usage](#basic-usage)
  - [Managing global public dependencies across modules](#managing-global-public-dependencies-across-modules)
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
  - [SSE Rooms](#sse-rooms)
    - [Enabling Rooms](#enabling-rooms)
    - [Session Room Operations](#session-room-operations)
    - [Broadcasting to Rooms](#broadcasting-to-rooms)
    - [Room Broadcaster (Decoupled Broadcasting)](#room-broadcaster-decoupled-broadcasting)
    - [Room Name Helpers](#room-name-helpers)
    - [Room Query Methods](#room-query-methods)
    - [Auto-Leave on Disconnect](#auto-leave-on-disconnect)
    - [Multi-Node Deployments with Redis](#multi-node-deployments-with-redis)
  - [SSE Subscriptions](#sse-subscriptions)
    - [Defining Event Metadata](#defining-event-metadata)
    - [Defining Resolvers](#defining-resolvers)
    - [Configuring the Manager](#configuring-the-manager)
    - [Integrating with a Controller](#integrating-with-a-controller)
    - [Publishing Events](#publishing-events)
    - [Refreshing Preferences Mid-Connection](#refreshing-preferences-mid-connection)
    - [Pipeline Semantics](#pipeline-semantics)
    - [Multi-Node Support](#multi-node-support)
    - [Data Loading with layered-loader](#data-loading-with-layered-loader)
    - [Testing](#testing)
  - [SSE Test Utilities](#sse-test-utilities)
    - [Quick Reference](#quick-reference)
    - [Inject vs HTTP Comparison](#inject-vs-http-comparison)
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
- [Gateway Configuration](#gateway-configuration)
  - [Quick Start](#quick-start)
  - [Annotating Routes](#annotating-routes)
  - [Avoiding Repetition With Defaults](#avoiding-repetition-with-defaults)
  - [Type-Safe Matching](#type-safe-matching)
  - [Field Reference](#field-reference)
  - [Generating Gateway Configs](#generating-gateway-configs)
  - [Inspecting the Manifest at Runtime](#inspecting-the-manifest-at-runtime)
  - [What's Not Covered](#whats-not-covered)

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

### Managing global public dependencies across modules

When your application has multiple secondary modules, you need a single type that combines all their public dependencies. The library exports an empty `PublicDependencies` interface that each module can augment via TypeScript's [module augmentation](https://www.typescriptlang.org/docs/handbook/declaration-merging.html#module-augmentation). Each module file adds its own public deps to this shared interface using `declare module`. The augmentations are **project-wide** — they apply everywhere as long as the augmenting file is part of your TypeScript compilation (included in `tsconfig.json`), with no explicit import chain required.

Start with a `CommonModule` that provides shared infrastructure dependencies (logger, config, etc.), then add domain modules that each augment the same interface independently.

```ts
// CommonModule.ts — shared infrastructure
import { AbstractModule, type InferPublicModuleDependencies } from 'opinionated-machine'

export class CommonModule extends AbstractModule {
  resolveDependencies(diOptions: DependencyInjectionOptions) {
    return {
      config: asSingletonFunction((): Config => loadConfig()),     // private — omitted
      logger: asServiceClass(Logger),                      // public
      eventEmitter: asServiceClass(AppEventEmitter),       // public
    }
  }
}

declare module 'opinionated-machine' {
  interface PublicDependencies extends InferPublicModuleDependencies<CommonModule> {}
}
```

```ts
// UsersModule.ts — no need to import CommonModule's type
import { AbstractModule, type InferPublicModuleDependencies } from 'opinionated-machine'

export class UsersModule extends AbstractModule {
  resolveDependencies(diOptions: DependencyInjectionOptions) {
    return {
      userService: asServiceClass(UserService),         // public
      userRepository: asRepositoryClass(UserRepository), // private — omitted
    }
  }
}

declare module 'opinionated-machine' {
  interface PublicDependencies extends InferPublicModuleDependencies<UsersModule> {}
}
```

```ts
// BillingModule.ts — independent, no chain
import { AbstractModule, type InferPublicModuleDependencies } from 'opinionated-machine'

export class BillingModule extends AbstractModule {
  resolveDependencies(diOptions: DependencyInjectionOptions) {
    return {
      billingService: asServiceClass(BillingService),       // public
      paymentGateway: asRepositoryClass(PaymentGateway),     // private — omitted
    }
  }
}

declare module 'opinionated-machine' {
  interface PublicDependencies extends InferPublicModuleDependencies<BillingModule> {}
}
```

Importing `PublicDependencies` from anywhere gives you the full accumulated type: `{ logger: Logger; eventEmitter: AppEventEmitter; userService: UserService; billingService: BillingService }`. Private dependencies (`config`, `userRepository`, `paymentGateway`) are omitted automatically. No explicit import chain between modules is needed — each module augments the interface independently.

#### Typing constructor dependencies within a module

Classes within a module can access both the module's own dependencies (including private ones like repositories) and all public dependencies from other modules. Combine `InferModuleDependencies` with `PublicDependencies` to get the full cradle type available at runtime:

```ts
// UsersModule.ts
import {
  AbstractModule,
  type InferModuleDependencies,
  type InferPublicModuleDependencies,
  type PublicDependencies,
} from 'opinionated-machine'

// Module's own deps (public + private) merged with all public deps from other modules
type UsersModuleInjectables = InferModuleDependencies<UsersModule> & PublicDependencies

export class UserService {
  private readonly repository: UserRepository
  private readonly logger: Logger  // from CommonModule's public deps

  constructor(dependencies: UsersModuleInjectables) {
    this.repository = dependencies.userRepository  // own private dep — accessible
    this.logger = dependencies.logger              // public dep from another module — accessible
    // dependencies.billingRepository              // private dep from another module — type error
  }
}

class UserRepository {}

export class UsersModule extends AbstractModule {
  resolveDependencies(diOptions: DependencyInjectionOptions) {
    return {
      userService: asServiceClass(UserService),
      userRepository: asRepositoryClass(UserRepository),
    }
  }
}

declare module 'opinionated-machine' {
  interface PublicDependencies extends InferPublicModuleDependencies<UsersModule> {}
}
```

This gives each class access to exactly what the DI container provides at runtime: the module's own registered dependencies plus all public dependencies from secondary modules. Private dependencies from other modules are excluded at the type level, matching the runtime behavior.

#### Constructing the combined dependency type for `DIContext`

Use `PublicDependencies` when building the full dependency type:

```ts
import type { PublicDependencies } from 'opinionated-machine'

type Dependencies = InferModuleDependencies<PrimaryModule> & PublicDependencies
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

Function-based resolvers (`asSingletonFunction`) cannot use the `ClassValue<T>` trick because functions don't have a `prototype` property that separates return type from parameter types. Use **indexed access** on `InferModuleDependencies` to type individual dependencies, and **always provide an explicit return type annotation** on the factory function:

```ts
import { S3Client } from '@aws-sdk/client-s3'

// Inside resolveDependencies():
config: asSingletonClass(Config),
logger: asServiceClass(Logger),

s3Client: asSingletonFunction(
  ({ config, logger }: {
    config: ModuleDependencies['config']
    logger: ModuleDependencies['logger']
  }): S3Client => {
    return new S3Client({
      region: config.awsRegion,
      credentials: { accessKeyId: config.awsAccessKey, secretAccessKey: config.awsSecretKey },
      logger,
    })
  },
),

// ...

// At the bottom of the file:
export type ModuleDependencies = InferModuleDependencies<MyModule>
```

Indexed access types (`ModuleDependencies['config']`) are resolved **lazily** by TypeScript — it looks up individual properties without computing the entire `ModuleDependencies` type, avoiding the cycle. Each dependency stays in sync with the module's resolvers automatically.

For cross-module dependencies, use `InferPublicModuleDependencies`:

```ts
type CommonDeps = InferPublicModuleDependencies<CommonModule>

redis: asSingletonFunction(
  ({ config }: { config: CommonDeps['config'] }): Redis => {
    return new Redis({ host: config.redis.host, port: config.redis.port })
  },
),
```

**The explicit return type is critical.** Without it, TypeScript attempts to infer the return type from the function body, which requires resolving the parameter types, which triggers the circular reference:

```ts
// BREAKS — no explicit return type, TypeScript infers it from the body,
// requiring config's type to be resolved, triggering the cycle:
s3Client: asSingletonFunction(
  ({ config }: { config: ModuleDependencies['config'] }) => {
    return new S3Client({ region: config.awsRegion })
  },
),
```

**Note:** `Pick<ModuleDependencies, 'a' | 'b'>` does **not** work — `Pick` requires `keyof ModuleDependencies`, which forces TypeScript to resolve the entire type and triggers the circular reference. Each property must be accessed individually via indexed access.

**Alternative: concrete parameter types**

You can use concrete types instead of indexed access when the return type is dynamic or difficult to spell out explicitly. Because concrete types don't reference `InferModuleDependencies`, there is no circularity, so TypeScript can infer the return type for you:

```ts
// Return type inferred automatically — Config is a concrete type that doesn't
// reference InferModuleDependencies, so there's no circular reference.
redisConfig: asSingletonFunction(
  ({ config }: { config: Config }) => {
    return config.getRedisConfig()
  },
),
```

The trade-off is that parameter types won't auto-sync if the module's resolver changes — but you'll still get a type error at the resolver level if the types diverge.

**Fallback: class wrapper**

If the adapter needs many dependencies and the inline syntax becomes too verbose, wrap the adaptation logic in a class and use `asSingletonClass` instead. The constructor can reference `ModuleDependencies` directly since `ClassValue<T>` breaks the cycle automatically — no return type annotation needed:

```ts
import { S3Client } from '@aws-sdk/client-s3'

// Full adapter — adds domain-specific methods:
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

// Thin wrapper — just bridges the constructor signature:
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

This is more heavyweight than a function resolver but provides full type safety with no explicit return type needed, and scales cleanly to any number of dependencies.

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
config: asSingletonFunction((): Config => loadConfig())
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
| `contractMetadataToRouteMapper` | Maps contract metadata to Fastify route options (see below) |

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

#### `contractMetadataToRouteMapper`

Allows attaching cross-cutting behavior (auth, rate limiting, tracing, etc.) to a route based on metadata defined in the
contract.

The return value is merged into Fastify's `RouteOptions` as a base.
The mapper can return any of: `config`, `bodyLimit`, `onRequest`, `preParsing`, `preValidation`, `preHandler`,
`preSerialization`, `onSend`, `onResponse`, `onError`, `onTimeout`, `onRequestAbort`.

```ts
// In the contract definition
const adminStreamContract = buildSseContract({
  method: 'get',
  pathResolver: () => '/api/admin/stream',
  // ...schemas...
  metadata: { requiresAuth: true, rateLimit: 100 },
})

// In the controller — driven by metadata, not duplicated per-route
private handleAdminStream = buildHandler(adminStreamContract, {
  sse: async (request, sse) => {
    const session = sse.start('keepAlive')
    // ...
  },
}, {
  contractMetadataToRouteMapper: (metadata) => ({
    config: { rateLimit: metadata.rateLimit },
    onRequest: metadata.requiresAuth ? authHook : undefined,
  }),
})
```

This is the same API as `contractMetadataToRouteMapper` in `@lokalise/fastify-api-contracts`, making it straightforward 
to share a single mapper function across REST, SSE, and dual-mode routes.

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

The test client depends on the session mode:

| Session Mode | Test Client | Why |
|-------------|-------------|--------|
| `autoClose` | `SSEInjectClient` or `injectSSE`/`injectPayloadSSE` | Handler completes and closes connection; all events available at once |
| `keepAlive` | `SSEHttpClient` | Connection stays open; events arrive incrementally via server push |

Enable the connection spy by passing `isTestMode: true` in diOptions (required for `awaitServerConnection`).

#### Testing keepAlive SSE (long-lived connections)

Use `SSEHttpClient` against your running app. The key pattern:

1. Connect with `awaitServerConnection` to eliminate the race condition
2. Call `collectEvents()` **before** pushing events (they arrive asynchronously)
3. Push events from the server via `sendEventInternal()` or `broadcastToRoom()`
4. Await the collected events
5. Always call `client.close()` to release the connection

```ts
import { SSEHttpClient, SSETestServer } from 'opinionated-machine'

describe('NotificationsSSEController', () => {
  let app: AppInstance
  let server: SSETestServer
  let controller: NotificationsSSEController

  beforeAll(async () => {
    app = await getApp({ /* your test config */ })
    controller = app.diContainer.resolve('notificationsSSEController')

    // SSETestServer.start() starts your app on a random port and provides baseUrl
    server = await SSETestServer.start(app)
  })

  afterAll(async () => {
    await server.close()
  })

  it('receives notifications over keepAlive SSE', async () => {
    // 1. Connect with awaitServerConnection to eliminate race condition
    const { client, serverConnection } = await SSEHttpClient.connect(
      server.baseUrl,
      '/api/notifications/stream',
      {
        query: { userId: 'test-user' },
        awaitServerConnection: { controller },
      },
    )

    expect(client.response.ok).toBe(true)

    // 2. Start collecting events BEFORE pushing (they arrive asynchronously)
    const eventsPromise = client.collectEvents(2)

    // 3. Push events from server
    await controller.sendEventInternal(serverConnection.id, {
      event: 'notification',
      data: { id: '1', message: 'Hello!' },
    })
    await controller.sendEventInternal(serverConnection.id, {
      event: 'notification',
      data: { id: '2', message: 'World!' },
    })

    // 4. Await collected events
    const events = await eventsPromise

    expect(events).toHaveLength(2)
    expect(JSON.parse(events[0].data)).toEqual({ id: '1', message: 'Hello!' })
    expect(JSON.parse(events[1].data)).toEqual({ id: '2', message: 'World!' })

    // 5. Clean up
    client.close()
  })
})
```

#### Testing autoClose SSE (request-response streaming)

Use `SSEInjectClient` or the contract-aware `injectSSE`/`injectPayloadSSE` helpers. No real HTTP server needed - all events are available immediately after the handler completes:

```ts
import { SSEInjectClient } from 'opinionated-machine'

it('streams chat completions', async () => {
  const client = new SSEInjectClient(app) // works without app.listen()

  const conn = await client.connectWithBody(
    '/api/chat/completions',
    { message: 'Hello world' },
  )

  expect(conn.getStatusCode()).toBe(200)
  const events = conn.getReceivedEvents()
  const chunks = events.filter((e) => e.event === 'chunk')
  expect(chunks.length).toBeGreaterThan(0)
})
```

#### Asserting documented error responses with `bodyForStatus`

When a contract declares `responseBodySchemasByStatusCode` for non-2xx responses (the shape the handler emits via `sse.respond(status, body)` before streaming starts), `injectSSE` / `injectPayloadSSE` expose a typed `bodyForStatus(status)` accessor:

```ts
import { buildSseContract } from '@lokalise/api-contracts'
import { z } from 'zod'
import { injectSSE } from 'opinionated-machine'

const streamContract = buildSseContract({
  method: 'get',
  pathResolver: () => '/api/stream',
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({}),
  responseBodySchemasByStatusCode: {
    401: z.object({ message: z.string() }),
    404: z.object({ resourceId: z.string() }),
  },
  serverSentEventSchemas: { message: z.object({ text: z.string() }) },
})

it('returns the documented 401 body when unauthenticated', async () => {
  const { bodyForStatus } = injectSSE(app, streamContract, {})

  // `body` is typed as `{ message: string }` — the 401 schema.
  // TS rejects status codes the contract doesn't declare, e.g. bodyForStatus(500).
  const body = await bodyForStatus(401)
  expect(body.message).toBe('Unauthorized')
})
```

`bodyForStatus(status)` awaits the response, asserts the actual status matches, JSON-parses the body, and runs it through the Zod schema declared for that status. It throws — with the offending status and a truncated body snippet — if the status doesn't match, the contract declares no schema for that status, the body isn't valid JSON, or Zod parsing fails. The raw `closed` promise is still exposed for callers that want to read `body: string` directly.

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

### SSE Rooms

SSE Rooms provide Socket.IO-style room functionality for grouping connections and broadcasting messages to specific groups. Common use cases include:

- **Multi-tenant systems** - Broadcast announcements to all users within an organization or team
- **Live dashboards** - Multiple users viewing the same dashboard join a room to receive real-time metric updates
- **Stock tickers** - Users subscribe to specific symbols; each symbol is a room receiving price updates
- **Sports/game scores** - Users following specific matches join those rooms for live score updates

#### Enabling Rooms

Room infrastructure is registered at the module level via `resolveDependencies()`. Controllers opt in with `rooms: true`, which resolves `sseRoomBroadcaster` from the DI cradle:

```ts
import { asValue } from 'awilix'
import {
  AbstractModule,
  AbstractSSEController,
  asSingletonClass,
  asSSEControllerClass,
  SSERoomBroadcaster,
  SSERoomManager,
} from 'opinionated-machine'

class DashboardModule extends AbstractModule {
  resolveDependencies() {
    return {
      // Required: room infrastructure — registered once, shared across controllers
      sseRoomManager: asValue(new SSERoomManager()),
      sseRoomBroadcaster: asSingletonClass(SSERoomBroadcaster), // expects 'sseRoomManager' in cradle — name must match exactly
    }
  }

  resolveControllers(diOptions: DependencyInjectionOptions) {
    return {
      // rooms: true → resolves 'sseRoomBroadcaster' from DI cradle
      dashboardController: asSSEControllerClass(DashboardSSEController, {
        diOptions,
        rooms: true,
      }),
    }
  }
}
```

> **Required DI registrations for rooms:** Any module using `rooms: true` must have both `sseRoomManager` and `sseRoomBroadcaster` registered in the DI container before the controller is resolved. `SSERoomBroadcaster` expects `sseRoomManager` in its constructor cradle.

#### Session Room Operations

When rooms are enabled, each SSE session has access to room operations via `session.rooms`:

```ts
private handleDashboardStream = buildHandler(dashboardStreamContract, {
  sse: async (request, sse) => {
    const session = sse.start('keepAlive')

    // Join one or more rooms
    session.rooms.join(`dashboard:${request.params.dashboardId}`)
    session.rooms.join(['org:acme', 'plan:enterprise']) // Multiple rooms

    // Leave rooms
    session.rooms.leave('plan:enterprise')
  },
})
```

#### Broadcasting to Rooms

Use `broadcastToRoom()` from your controller to send type-safe messages to all connections in a room. Event names and data are validated against your contract schemas at compile time:

```ts
class DashboardSSEController extends AbstractSSEController<typeof contracts> {
  // Send metrics update to everyone viewing the dashboard
  // Event name and data are type-checked against contract's sseEvents
  async broadcastMetricsUpdate(dashboardId: string, metrics: DashboardMetrics) {
    const count = await this.broadcastToRoom(
      `dashboard:${dashboardId}`,
      'metricsUpdate', // Must be a valid event name from contracts
      metrics,         // Must match the schema for 'metricsUpdate'
    )
    console.log(`Metrics sent to ${count} viewers`)
  }

  // Broadcast to a room
  async broadcastChange(dashboardId: string, change: DashboardChange) {
    await this.broadcastToRoom(
      `dashboard:${dashboardId}`,
      'change',
      change,
    )
  }

  // Broadcast to multiple rooms (connections in any room receive it, de-duplicated)
  async announceFeature(feature: string) {
    const count = await this.broadcastToRoom(
      ['premium', 'beta-testers'],
      'featureFlag',
      { flag: feature, enabled: true },
    )
    // Each connection receives the message only once, even if in multiple rooms
  }

  // Local-only broadcast (skip Redis propagation in multi-node setups)
  async localAnnouncement(room: string, message: string) {
    await this.broadcastToRoom(room, 'announcement', { message }, { local: true })
  }
}
```

#### Room Broadcaster (Decoupled Broadcasting)

The `broadcastToRoom()` method on the controller is `protected`, which means domain services (use cases, event handlers, message queue consumers) can't call it directly. The `SSERoomBroadcaster` solves this — it's a shared, non-generic service registered in DI that domain services receive directly:

```ts
import { defineEvent, type SSERoomBroadcaster } from 'opinionated-machine'
import { z } from 'zod'

// 1. Define type-safe events with schemas
const metricsUpdateEvent = defineEvent(
  'metricsUpdate',
  z.object({ cpu: z.number(), memory: z.number() }),
)

// 2. Register domain service in resolveDependencies()
class DashboardModule extends AbstractModule {
  resolveDependencies() {
    return {
      sseRoomManager: asValue(new SSERoomManager()),
      sseRoomBroadcaster: asSingletonClass(SSERoomBroadcaster), // expects 'sseRoomManager' in cradle — name must match exactly
      metricsService: asSingletonClass(MetricsService),
    }
  }

  resolveControllers(diOptions: DependencyInjectionOptions) {
    return {
      dashboardController: asSSEControllerClass(DashboardSSEController, {
        diOptions,
        rooms: true,
      }),
    }
  }
}

// 3. Inject broadcaster into domain services — no generic needed
class MetricsService {
  private broadcaster: SSERoomBroadcaster

  constructor(deps: { sseRoomBroadcaster: SSERoomBroadcaster }) {
    this.broadcaster = deps.sseRoomBroadcaster
  }

  async onMetricsUpdate(dashboardId: string, metrics: { cpu: number; memory: number }) {
    // Type-safe: data is validated against the event's schema at compile time
    await this.broadcaster.broadcastToRoom(
      `dashboard:${dashboardId}`,
      metricsUpdateEvent,
      metrics,
    )
  }
}
```

The broadcaster provides `broadcastToRoom()` (with `defineEvent()`-based type safety), `broadcastMessage()` (raw SSEMessage), plus room query methods (`getConnectionsInRoom`, `getConnectionCountInRoom`). Multiple controllers register their `sendEvent` with the same broadcaster — the first to recognize a connection handles delivery.

#### Room Name Helpers

Room names are plain strings (like Socket.IO), but `defineRoom()` adds type-safe resolvers that ensure consistent naming across controllers and domain services:

```ts
import { defineRoom } from 'opinionated-machine'

// Define typed room name resolvers
const dashboardRoom = defineRoom<{ dashboardId: string }>(
  ({ dashboardId }) => `dashboard:${dashboardId}`,
)

const projectChannelRoom = defineRoom<{ projectId: string; channelId: string }>(
  ({ projectId, channelId }) => `project:${projectId}:channel:${channelId}`,
)

// In controller handler — params are type-checked
session.rooms.join(dashboardRoom({ dashboardId: request.params.dashboardId }))

// In domain service — same resolver, same type safety
await broadcaster.broadcastToRoom(
  dashboardRoom({ dashboardId }),
  'metricsUpdate',
  metrics,
)
```

`defineRoom()` is a zero-overhead identity wrapper — it simply returns the function you pass in, typed as `RoomNameResolver<TParams>`. The value is purely at compile time: typos in room name patterns become type errors, and refactoring a room's naming scheme only requires changing one place.

#### Room Query Methods

Controllers have access to room query methods:

```ts
class DashboardSSEController extends AbstractSSEController<typeof contracts> {
  // Get all connection IDs in a room
  getDashboardViewers(dashboardId: string): string[] {
    return this.getConnectionsInRoom(`dashboard:${dashboardId}`)
  }

  // Get count of connections in a room
  getDashboardViewerCount(dashboardId: string): number {
    return this.getConnectionCountInRoom(`dashboard:${dashboardId}`)
  }

  // Get all rooms a specific connection is in
  getConnectionRooms(connectionId: string): string[] {
    return this.getRooms(connectionId)
  }

  // Manually join/leave rooms from controller (useful for admin operations)
  moveToRoom(connectionId: string, fromRoom: string, toRoom: string) {
    this.leaveRoom(connectionId, fromRoom)
    this.joinRoom(connectionId, toRoom)
  }
}
```

#### Auto-Leave on Disconnect

When a connection closes (client disconnect or server close), it automatically leaves all rooms. No manual cleanup is required.

#### Multi-Node Deployments with Redis

For multi-node deployments where connections are distributed across servers, pass a Redis adapter to `SSERoomManager` when registering room infrastructure:

```ts
import { RedisAdapter } from '@opinionated-machine/sse-rooms-redis'

class InfraModule extends AbstractModule {
  resolveDependencies() {
    return {
      sseRoomManager: asSingletonFunction(({ redis }: { redis: Redis }): SSERoomManager =>
        new SSERoomManager({
          adapter: new RedisAdapter({
            pubClient: redis,
            subClient: redis.duplicate(),
            channelPrefix: 'myapp:sse:room:', // Optional, default: 'sse:room:'
          }),
        }),
      ),
      sseRoomBroadcaster: asSingletonClass(SSERoomBroadcaster), // expects 'sseRoomManager' in cradle — name must match exactly
    }
  }
}

class DashboardModule extends AbstractModule {
  resolveControllers(diOptions: DependencyInjectionOptions) {
    return {
      dashboardController: asSSEControllerClass(DashboardSSEController, {
        diOptions,
        rooms: true,
      }),
    }
  }
}
```

The Redis adapter uses Pub/Sub for cross-node message propagation. When you call `broadcastToRoom()`, the message is published to Redis and delivered to all nodes that have connections in that room.

See the [@opinionated-machine/sse-rooms-redis](./packages/sse-rooms-redis/README.md) package for detailed documentation on Redis adapter configuration and usage.

### SSE Subscriptions

SSE Subscriptions add user-centered event filtering on top of SSE Rooms. Users connect once to a universal stream, and a **resolver pipeline** determines which events reach them based on membership, preferences, and arbitrary business rules.

#### Defining Event Metadata

Define a discriminated union describing all event scopes, then create type-safe guards with `defineEventMetadata()`:

```typescript
import { defineEventMetadata } from 'opinionated-machine'

type EventMetadata =
  | { scope: 'project'; projectId: string }
  | { scope: 'team'; teamId: string }
  | { scope: 'global' }

const meta = defineEventMetadata<EventMetadata>()('scope', ['project', 'team', 'global'])

// In resolvers, guards narrow the type:
if (meta.project(event.metadata)) {
  event.metadata.projectId // TypeScript knows this is string
}
```

#### Defining Resolvers

Resolvers are stateless filters evaluated in pipeline order. Each resolver can `allow`, `deny`, or `defer`:

```typescript
import type { SubscriptionResolver, SubscriptionContext, FilterVerdict } from 'opinionated-machine'

class ProjectMembershipResolver {
  readonly name = 'project-membership'

  async onConnect(ctx: SubscriptionContext<UserCtx>) {
    const memberships = await this.membershipLoader.get(ctx.userContext.userId)
    const projectIds = new Set(memberships.map(m => m.projectId))
    return {
      userContext: { ...ctx.userContext, projectIds },
      rooms: Array.from(projectIds).map(id => `project:${id}`),
    }
  }

  evaluate(ctx: SubscriptionContext<UserCtx>, event: IncomingEvent<EventMetadata>): FilterVerdict {
    if (meta.project(event.metadata)) {
      return ctx.userContext.projectIds.has(event.metadata.projectId)
        ? { action: 'allow' }
        : { action: 'deny', reason: 'not a project member' }
    }
    return { action: 'defer' }
  }

  async refresh(ctx: SubscriptionContext<UserCtx>) {
    // Re-fetch memberships on demand
    const memberships = await this.membershipLoader.get(ctx.userContext.userId)
    const projectIds = new Set(memberships.map(m => m.projectId))
    return {
      userContext: { ...ctx.userContext, projectIds },
      rooms: Array.from(projectIds).map(id => `project:${id}`),
    }
  }
}
```

#### Configuring the Manager

```typescript
import { SSESubscriptionManager } from 'opinionated-machine'

const subscriptionManager = new SSESubscriptionManager<UserCtx, EventMetadata>(
  {
    resolveUserContext: async (request) => ({
      userId: request.user.id,
      projectIds: new Set(),
      mutedEventTypes: new Set(),
    }),
    resolvers: [
      new ProjectMembershipResolver(membershipLoader),
      new MutePreferencesResolver(prefsLoader),
    ],
    defaultPolicy: 'deny',
    resolveUserId: (ctx) => ctx.userId,
  },
  { sseRoomManager, sseRoomBroadcaster },
)
```

#### Integrating with a Controller

Wire `handleConnect` and `handleDisconnect` into the SSE session lifecycle:

```typescript
class NotificationController extends AbstractSSEController<Contracts> {
  private handleStream = buildHandler(contract, {
    sse: (request, sse) => {
      const session = sse.start('keepAlive')
      this.subscriptionManager.handleConnect(session).catch(() => {
        // Handle connection setup failure (e.g., resolver threw)
      })
    },
  }, {
    onClose: (session) => {
      this.subscriptionManager.handleDisconnect(session)
    },
  })
}
```

#### Publishing Events

```typescript
const result = await subscriptionManager.publish({
  eventName: 'announcement',
  data: { message: 'New feature released!' },
  targetRooms: ['project:123'],
  metadata: { scope: 'project', projectId: '123' },
})
// result: { delivered: 5, filtered: 2 }
```

`targetRooms` controls routing:
- **Specific rooms** (`['project:123']`) — broadcast to those rooms, filter via resolver pipeline
- **`undefined`** (omitted) — broadcast to all rooms of all managed connections
- **Empty array** (`[]`) — no-op, returns `{ delivered: 0, filtered: 0 }`

#### Refreshing Preferences Mid-Connection

When a user updates preferences (e.g., mutes an event type), refresh their active connections:

```typescript
// In your REST endpoint handler:
await prefsLoader.invalidateCacheFor(userId)
await subscriptionManager.refreshUser(userId)
```

The manager diffs rooms and joins/leaves as needed — no reconnection required.

#### Pipeline Semantics

- Resolvers are evaluated in array order
- First `deny` short-circuits — event is not delivered
- `allow` does not short-circuit — subsequent resolvers can still deny
- If all resolvers return `defer`, `defaultPolicy` applies (default: `deny`)
- Resolver `evaluate()` errors are treated as `deny`
- Resolver `refresh()` errors are caught per-resolver — the failed resolver keeps its previous state while remaining resolvers continue refreshing
- Later resolvers in the array receive the accumulated `userContext` from earlier resolvers — use spread (`{ ...ctx.userContext, ...newFields }`) to preserve prior resolver data
- `defaultPolicy` defaults to `'deny'` when not specified

#### Multi-Node Support

- Metadata flows through the adapter chain (Redis pub/sub) alongside the SSE message
- Resolver pipeline runs locally on each node for its own connections
- Wire format is a single v1 schema with optional `meta` — older nodes simply have no metadata
- Use `layered-loader` for distributed cache invalidation across nodes

#### Data Loading with layered-loader

`layered-loader` is recommended (not required) for resolver data loading. It provides in-memory → Redis → DB caching with TTL, refresh-ahead, and distributed invalidation:

```typescript
import { Loader } from 'layered-loader'

const membershipLoader = new Loader<ProjectMembership[]>({
  inMemoryCache: { cacheType: 'lru-map', ttlInMsecs: 120_000, maxItems: 500 },
  asyncCache: new RedisCache(redis, { json: true, ttlInMsecs: 900_000 }),
  dataSources: [membershipDataSource],
})
```

#### Testing

Create mock resolvers for unit tests:

```typescript
const mockResolver = {
  name: 'mock',
  evaluate: vi.fn().mockReturnValue({ action: 'allow' }),
}

const manager = new SSESubscriptionManager(
  { resolveUserContext: async () => mockContext, resolvers: [mockResolver] },
  { sseRoomManager, sseRoomBroadcaster },
)
```

### SSE Test Utilities

The library provides utilities for testing SSE endpoints.

**Two transport methods:**
- **Inject** - Uses Fastify's built-in `inject()` to simulate HTTP requests directly in-memory, without network overhead. No `listen()` required. Handler must close the session for the request to complete.
- **Real HTTP** - Actual HTTP via `fetch()`. Requires the server to be listening. Supports long-lived sessions.

#### Which test client should I use?

**Pick based on your SSE session mode:**

| Session Mode | Test Client | Reason |
|-------------|-------------|--------|
| `autoClose` | `SSEInjectClient` or `injectSSE`/`injectPayloadSSE` | Handler completes and closes connection; all events available at once |
| `keepAlive` | `SSEHttpClient` | Connection stays open; events arrive incrementally via server push |

`SSEInjectClient` and `injectSSE`/`injectPayloadSSE` do the same thing (Fastify inject), but `injectSSE`/`injectPayloadSSE` provide type safety via contracts while `SSEInjectClient` works with raw URLs.

#### Detailed Comparison

| Feature | Inject (`SSEInjectClient`, `injectSSE`) | HTTP (`SSEHttpClient`) |
|---------|----------------------------------------|------------------------|
| **Connection** | Fastify's `inject()` - in-memory | Real HTTP via `fetch()` |
| **Event delivery** | All events returned at once (after handler closes) | Events arrive incrementally |
| **Connection lifecycle** | Handler must close for request to complete | Can stay open indefinitely |
| **Server requirement** | No `listen()` needed | Requires a listening server (`SSETestServer.start(app)` or manual `app.listen()`) |
| **Best for** | `autoClose` SSE (OpenAI-style, batch exports) | `keepAlive` SSE (notifications, live feeds, rooms) |
| **Dual-mode sync** | Use `app.inject()` with `accept: 'application/json'` | Same |

#### SSEHttpClient

For testing `keepAlive` SSE connections using real HTTP. Requires a listening server — use `SSETestServer.start(app)` to start your app on a random port:

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

For testing `autoClose` SSE streams (like OpenAI completions). Uses Fastify's `inject()` - no `app.listen()` needed:

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

// All events are available immediately (inject waits for handler to complete)
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

Dual-mode contracts use a single `sync` handler that returns the response data. The framework validates the return value against the contract schema, then sends it. Do not call `reply.send()` — return the data directly instead. Use `reply.code()` to set status codes and `reply.header()` to set response headers.

> **Note:** The `reply` parameter is typed as `SyncModeReply`, which omits `send()` to prevent accidental misuse. The framework handles sending the response after validation.

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
    // Optional: attach behavior driven by contract metadata
    contractMetadataToRouteMapper: (metadata) => ({
      config: { rateLimit: metadata.rateLimit },
      onRequest: metadata.requiresAuth ? authHook : undefined,
    }),
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
      // Dual-mode controller with rooms enabled
      dashboardController: asDualModeControllerClass(DashboardController, { diOptions, rooms: true }),
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

The testing approach depends on the SSE session mode:

| SSE Mode | Test Client | Why |
|----------|-------------|-----|
| `autoClose` | `SSEInjectClient` or `injectSSE`/`injectPayloadSSE` | Handler completes and closes the connection, so all events are available at once via inject |
| `keepAlive` | `SSEHttpClient` + `SSETestServer.start(app)` | Connection stays open after handler returns; events arrive incrementally from server pushes |

#### Testing autoClose dual-mode (request-response streaming)

Use `SSEInjectClient` for dual-mode controllers where the SSE handler uses `autoClose`. No real HTTP server needed - Fastify's inject returns all events after the handler completes:

```ts
import { SSEInjectClient } from 'opinionated-machine'

describe('ChatDualModeController', () => {
  let app: AppInstance
  let injectClient: SSEInjectClient

  beforeAll(async () => {
    app = await getApp({ /* your test config */ })
    injectClient = new SSEInjectClient(app)
  })

  afterAll(async () => {
    await app.diContainer.dispose()
  })

  it('returns sync response for Accept: application/json', async () => {
    const response = await app.inject({
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
```

#### Testing keepAlive dual-mode (long-lived connections)

Use `SSEHttpClient` against your running app, the same pattern as single-mode keepAlive SSE. For test lifecycle convenience, you can use `SSETestServer.start(app)` to start your pre-configured app on a random port:

```ts
import { SSEHttpClient, SSETestServer } from 'opinionated-machine'

describe('DashboardDualModeController', () => {
  let app: AppInstance
  let server: SSETestServer
  let controller: DashboardController

  beforeAll(async () => {
    app = await getApp({ /* your test config */ })
    controller = app.diContainer.resolve('dashboardController')

    // SSETestServer.start() takes your pre-configured app and starts it on a random port
    server = await SSETestServer.start(app)
  })

  afterAll(async () => {
    await app.diContainer.dispose()
    await server.close()
  })

  // Sync mode works the same as autoClose — use Fastify inject
  it('returns JSON for sync requests', async () => {
    const response = await app.inject({
      method: 'get',
      url: '/api/dashboard/updates',
      headers: { accept: 'application/json' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('application/json')
  })

  // keepAlive SSE requires SSEHttpClient with awaitServerConnection
  it('receives server-pushed events over keepAlive SSE', async () => {
    // 1. Connect with awaitServerConnection to eliminate race condition
    const { client, serverConnection } = await SSEHttpClient.connect(
      server.baseUrl,
      '/api/dashboard/updates',
      { awaitServerConnection: { controller } },
    )

    // 2. Start collecting events BEFORE pushing (they arrive asynchronously)
    const eventsPromise = client.collectEvents(2)

    // 3. Push events from the server side
    await controller.pushUpdate(serverConnection.id, {
      event: 'update',
      data: { type: 'metric', value: 42 },
    })
    await controller.pushUpdate(serverConnection.id, {
      event: 'update',
      data: { type: 'alert', value: 100 },
    })

    // 4. Await collected events
    const events = await eventsPromise
    expect(events).toHaveLength(2)
    expect(JSON.parse(events[0].data)).toEqual({ type: 'metric', value: 42 })

    // 5. Always close the client to release the connection
    client.close()
  })

  // keepAlive SSE + rooms
  it('receives room broadcasts over keepAlive SSE', async () => {
    const { client } = await SSEHttpClient.connect(
      server.baseUrl,
      '/api/dashboard/updates',
      {
        query: { dashboardId: 'dash-1' },
        awaitServerConnection: { controller },
      },
    )

    // Broadcast to the room
    const eventsPromise = client.collectEvents(1)
    await controller.broadcastToRoom('dashboard:dash-1', 'update', {
      type: 'room-update',
      value: 99,
    })

    const events = await eventsPromise
    expect(JSON.parse(events[0].data)).toEqual({ type: 'room-update', value: 99 })

    client.close()
  })

  // Sync and SSE can coexist concurrently
  it('sync requests work while keepAlive SSE connections are active', async () => {
    // Establish keepAlive SSE connection
    const { client: sseClient } = await SSEHttpClient.connect(
      server.baseUrl,
      '/api/dashboard/updates',
      { awaitServerConnection: { controller } },
    )

    // Sync request works while SSE is connected
    const response = await app.inject({
      method: 'get',
      url: '/api/dashboard/updates',
      headers: { accept: 'application/json' },
    })
    expect(response.statusCode).toBe(200)

    sseClient.close()
  })
})

## Gateway Configuration

Most services keep two copies of every route's policy: one in code, another in
a hand-edited Envoy / KrakenD / Kong config. They drift, and outages happen at
the seam. This feature lets you declare routing policy — timeouts, retries,
rate limits, CORS, JWT auth, caching, header transforms, traffic matching —
**next to the controller route it applies to**, then generate the gateway
config from a single source of truth.

Generators ship as separate npm packages so your service binary doesn't pull
them in:

| Gateway | Package | Output |
| ------- | ------- | ------ |
| Envoy   | [`@opinionated-machine/gateway-envoy`](./packages/gateway-envoy)     | static v3 YAML/JSON |
| KrakenD | [`@opinionated-machine/gateway-krakend`](./packages/gateway-krakend) | declarative v3 JSON |
| Kong    | [`@opinionated-machine/gateway-kong`](./packages/gateway-kong)       | DB-less declarative YAML/JSON |

### Quick Start

A complete round-trip in two steps. First, annotate routes in your existing
controller:

```ts
import { buildRestContract } from '@lokalise/api-contracts'
import { buildFastifyRoute } from '@lokalise/fastify-api-contracts'
import {
  AbstractController,
  type BuildRoutesReturnType,
  type GatewayMetadataValue,
  withGatewayMetadata,
} from 'opinionated-machine'
import { z } from 'zod/v4'

const getUser = buildRestContract({
  method: 'get',
  successResponseBodySchema: z.object({ id: z.string() }),
  requestPathParamsSchema: z.object({ userId: z.string() }),
  pathResolver: (p) => `/users/${p.userId}`,
})
const createUser = buildRestContract({
  method: 'post',
  requestBodySchema: z.object({ name: z.string() }),
  successResponseBodySchema: z.object({ id: z.string() }),
  pathResolver: () => '/users',
})

export class UsersController extends AbstractController<typeof UsersController.contracts> {
  static readonly contracts = { getUser, createUser } as const

  // Applies to every route in this controller; routes can override.
  override readonly gatewayDefaults: GatewayMetadataValue = {
    upstream: 'users-service',
    timeouts: { request: '5s' },
    auth: { required: true },
  }

  private getUser    = buildFastifyRoute(UsersController.contracts.getUser,    async (req, reply) => { /* … */ })
  private createUser = buildFastifyRoute(UsersController.contracts.createUser, async (req, reply) => { /* … */ })

  buildRoutes(): BuildRoutesReturnType<typeof UsersController.contracts> {
    return {
      getUser: withGatewayMetadata(UsersController.contracts.getUser, this.getUser, {
        cache: { ttl: '60s' },
      }),
      createUser: withGatewayMetadata(UsersController.contracts.createUser, this.createUser, {
        rateLimit: { requests: 10, per: '1m', key: 'ip' },
      }),
    }
  }
}
```

Then write a small script that turns the running service definition into a
gateway config — wire it into your build / CI pipeline:

```ts
// bin/render-envoy.ts
import { writeFileSync } from 'node:fs'
import { renderEnvoyConfig } from '@opinionated-machine/gateway-envoy'
import { buildContext } from '../src/diContext.ts'   // your DIContext factory

const ctx = await buildContext()
const manifest = ctx.buildGatewayManifest({
  service: 'users-api',
  defaults: { cors: { origins: ['https://app.example.com'], credentials: true } },
})

const { yaml, warnings } = renderEnvoyConfig(manifest, {
  listenPort: 8080,
  clusters: { 'users-service': { hosts: ['users:8081'] } },
})

writeFileSync('envoy.yaml', yaml)
if (warnings.length) console.warn('[envoy]', warnings)
```

```sh
$ tsx bin/render-envoy.ts && envoy --mode validate -c envoy.yaml
configuration 'envoy.yaml' OK
```

The rest of this section unpacks each piece in detail.

### Annotating Routes

There are two equivalent ways to attach metadata. Pick whichever fits your
controller style — both validate the metadata at the call site, both stamp
the same hidden symbol on the route, and both are read identically by the
manifest builder.

**For `buildApiRoute`-built routes** (`AbstractApiController`), pass
`gatewayMetadata` inline via the options argument:

```ts
class UsersApiController extends AbstractApiController<typeof UsersApiController.contracts> {
  static readonly contracts = { getUser, createUser, deleteUser } as const

  readonly routes = {
    getUser: buildApiRoute(UsersApiController.contracts.getUser, async (req) => /* … */, {
      gatewayMetadata: { cache: { ttl: '60s' } },
    }),
    createUser: buildApiRoute(UsersApiController.contracts.createUser, async (req) => /* … */, {
      gatewayMetadata: { rateLimit: { requests: 10, per: '1m', key: 'ip' } },
    }),
    deleteUser: buildApiRoute(UsersApiController.contracts.deleteUser, async (req) => /* … */),
    // ^ no per-route policy; inherits controller + service defaults
  }
}
```

**For `buildFastifyRoute`-built routes** (`AbstractController`), or when you
prefer to keep all gateway annotations in one scannable block separate from
route construction, wrap with `withGatewayMetadata(contract, route, metadata)`:

```ts
buildRoutes() {
  return {
    getUser:    withGatewayMetadata(c.getUser,    this.getUser,    { cache: { ttl: '60s' } }),
    createUser: withGatewayMetadata(c.createUser, this.createUser, { rateLimit: { requests: 10, per: '1m', key: 'ip' } }),
    deleteUser: this.deleteUser,    // no per-route policy; inherits defaults
  }
}
```

The contract drives type inference on `match.headers`, `match.query`, and
`rateLimit.key` — see [Type-Safe Matching](#type-safe-matching). Metadata
fields are documented in [Field Reference](#field-reference).

Annotations are invisible to Fastify (stamped via a non-enumerable `Symbol`),
so adding them never changes runtime behaviour and you can introduce them
gradually on an existing service. If both inline `gatewayMetadata` and
`withGatewayMetadata` are applied to the same route, the later call
overwrites — there is no merge; pick one form per route.

### Avoiding Repetition With Defaults

Most fields you'd write per route — upstream, base timeouts, auth posture,
shared tags — are the same across every route in a controller, or every route
in a service. Declare them once:

| Layer | Where | When to use |
| ----- | ----- | ----------- |
| Service-wide | `buildGatewayManifest({ defaults: … })` | Cross-cutting policy: CORS, idle timeouts, observability tags |
| Controller   | `override readonly gatewayDefaults = { … }` | Per-controller upstream, auth posture, base timeouts |
| Per-route    | `buildApiRoute(..., { gatewayMetadata })` *or* `withGatewayMetadata(...)` | Anything specific to one endpoint |

Layers deep-merge in that order: service → controller → route. **Arrays in
later layers replace** (not append), which keeps `weights`, `tags`, and
`match.headers` predictable.

```ts
context.buildGatewayManifest({
  service: 'users-api',
  defaults: {
    timeouts: { idle: '60s', connect: '1s' },
    cors: { origins: ['https://app.example.com'], credentials: true },
    tags: ['users-api'],
  },
})
```

### Type-Safe Matching

`match.headers` and `match.query` keys are inferred from the contract's
`requestHeaderSchema` / `requestQuerySchema`. Typos and stale references
become compile errors before you ever ship a config:

```ts
const getUser = buildRestContract({
  method: 'get',
  successResponseBodySchema: ResponseBody,
  requestHeaderSchema: z.object({ 'x-trace-id': z.string() }),
  requestPathParamsSchema: z.object({ userId: z.string() }),
  pathResolver: (p) => `/users/${p.userId}`,
})

withGatewayMetadata(getUser, this.getUser, {
  match: {
    headers: {
      'x-trace-id': { regex: '^[a-f0-9]+$' },   // ✅ type-checked against the contract
      'x-typo':     'foo',                       // ❌ compile error
    },
    customHeaders: {
      'x-cf-tenant': 'enterprise',               // ✅ explicit escape hatch for headers not in the contract
    },
  },
})
```

`rateLimit.key` narrows the same way — `{ header: 'x-trace-id' }` only works
if `'x-trace-id'` is in `requestHeaderSchema`; otherwise use
`{ customHeader: '…' }`.

The inline form on `buildApiRoute` provides the same narrowing — the contract
is the first argument, so TS infers it for `gatewayMetadata` automatically:

```ts
buildApiRoute(getUser, async (req) => /* … */, {
  gatewayMetadata: {
    match: { headers: { 'x-trace-id': { regex: '^[a-f0-9]+$' } } }, // ✅
    // 'x-typo' here would be a compile error against the contract's schema.
  },
})
```

### Field Reference

Every field is optional. The shapes below cover the common cases — see
[`gatewayMetadata.ts`](./lib/gateway/gatewayMetadata.ts) for the complete Zod
schema, which is also what produces precise validation errors at generation
time.

| Field | Example | Notes |
| ----- | ------- | ----- |
| `upstream` | `'users-service'` | Logical cluster name; resolved to a host by the generator |
| `timeouts` | `{ request: '5s', idle: '60s', connect: '1s' }` | Duration units: `ms` / `s` / `m` / `h` |
| `retry` | `{ attempts: 2, on: ['5xx', 'connect-failure'], perTryTimeout: '2s' }` | |
| `rateLimit` | `{ requests: 100, per: '1m', key: 'ip' }` | `key`: `'ip'`, `{ header }`, `{ customHeader }`, `{ query }`, `{ customQuery }` |
| `cache` | `{ ttl: '60s', methods: ['GET'], vary: ['Accept-Language'] }` | |
| `cors` | `{ origins: ['https://app.example.com'], credentials: true }` | |
| `auth` | `{ required: true, jwt: { issuer: '…', audiences: ['…'], jwksUri: '…' } }` | |
| `circuitBreaker` | `{ maxRequests: 100, maxRetries: 3 }` | |
| `match` | `{ headers, customHeaders, query, customQuery, host }` | Rule values: bare string (exact), `{ exact }`, `{ prefix }`, `{ regex }` |
| `rewrite` | `{ stripPrefix: '/v2' }` or `{ replacePrefix: { from: '/v1', to: '/v2' } }` | |
| `traffic` | `{ weights: [{ upstream: 'a', weight: 80 }, { upstream: 'b', weight: 20 }] }` | Also `shadow: { upstream, percent }` |
| `headers` | `{ request: { add: { 'x-internal': 'true' }, remove: ['cookie'] }, response: … }` | Free-form keys; typically infra headers not in the contract |
| `tags`, `visibility` | `tags: ['users']`, `visibility: 'internal'` | Documentation / partitioning |
| `extensions` | `{ envoy: { … }, krakend: { … }, kong: { … } }` | Vendor escape hatch; merged onto the generated route last |

### Generating Gateway Configs

Each generator is a pure function — manifest in, config out — so you typically
call them from a small build-time script. Pick one or all:

```ts
import { writeFileSync } from 'node:fs'
import { renderEnvoyConfig }   from '@opinionated-machine/gateway-envoy'
import { renderKrakendConfig } from '@opinionated-machine/gateway-krakend'
import { renderKongConfig }    from '@opinionated-machine/gateway-kong'

const manifest = context.buildGatewayManifest({ service: 'users-api' })

writeFileSync('envoy.yaml',
  renderEnvoyConfig(manifest, {
    listenPort: 8080,
    clusters: { 'users-service': { hosts: ['users:8081'] } },
  }).yaml)

writeFileSync('krakend.json',
  JSON.stringify(renderKrakendConfig(manifest, {
    port: 8080,
    upstreams: { 'users-service': 'http://users:8081' },
  }).json, null, 2))

writeFileSync('kong.yaml',
  renderKongConfig(manifest, {
    upstreams: { 'users-service': { url: 'http://users:8081' } },
  }).yaml)
```

Each result includes `warnings: string[]` listing metadata fields the gateway
can't natively express — log them so policy isn't silently dropped (e.g. Envoy
doesn't ship an HTTP cache filter, so `cache.ttl` will appear in
`warnings` under the Envoy generator). When you need a knob the universal
model doesn't cover, hand-write it under `extensions.<vendor>` on the route —
generators merge that block onto the rendered route last.

For each gateway's full mapping table and quirks:

- [`@opinionated-machine/gateway-envoy`](./packages/gateway-envoy/README.md)
- [`@opinionated-machine/gateway-krakend`](./packages/gateway-krakend/README.md)
- [`@opinionated-machine/gateway-kong`](./packages/gateway-kong/README.md)

### Inspecting the Manifest at Runtime

When you want the manifest from outside Node — a deployment CLI written in
another language, an ops dashboard, a debug-time `curl` — register
`fastifyGatewayPlugin`. The running service then exposes its manifest both in
code and over HTTP:

```ts
import { fastifyGatewayPlugin } from 'opinionated-machine'

await app.register(fastifyGatewayPlugin, {
  context,                                    // your DIContext
  defaults: { service: 'users-api' },         // service name + any service-wide defaults
  // exposeRoute: '/__gateway/manifest',      // opt-in HTTP route; omit to keep the manifest in-process only
})

// In code, e.g. in another plugin or a graceful-shutdown drain hook:
const manifest = app.buildGatewayManifest()

// Optionally fetch over HTTP from a CLI / sibling process — only when you
// set `exposeRoute` above. The plugin never registers an HTTP route by
// default to avoid leaking internal routing topology to unauthenticated
// callers; pair it with auth middleware appropriate for your service.
//   curl http://localhost:8080/__gateway/manifest | jq '.routes'
```

The manifest is rebuilt on every call, so it always reflects the current set
of registered controllers.

### What's Not Covered

- **SSE and dual-mode controllers.** Only routes from `AbstractController` and
  `AbstractApiController` appear in the manifest today. Streaming routes still
  proxy through every gateway, but they aren't listed.
- **Fields a particular gateway can't natively express.** They show up in
  `result.warnings` rather than disappearing. Reach for `extensions.<vendor>`
  to hand-write the missing piece on a per-route basis.
- **Runtime drift detection.** The manifest is built from your code; the
  gateway runs separately. The generators don't compare deployed gateway
  state against the manifest.

