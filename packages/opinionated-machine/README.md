# opinionated-machine
Very opinionated DI framework for fastify, built on top of awilix

## Table of Contents

- [Basic usage](#basic-usage)
  - [Managing global public dependencies across modules](#managing-global-public-dependencies-across-modules)
  - [Avoiding circular dependencies in typed cradle parameters](#avoiding-circular-dependencies-in-typed-cradle-parameters)
- [Defining controllers](#defining-controllers)
- [Migrating from legacy contracts](#migrating-from-legacy-contracts)
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
    - [`asApiControllerClass`](#asapicontrollerclasstype-opts)
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
  - [Defining SSE Routes](#defining-sse-routes)
  - [Session Modes](#session-modes)
  - [SSE Session Methods](#sse-session-methods)
  - [Route Options](#route-options)
  - [Error Handling](#error-handling)
  - [Graceful Shutdown](#graceful-shutdown)
  - [Dual-Mode Routes](#dual-mode-routes)
  - [SSE Parsing Utilities](#sse-parsing-utilities)
    - [parseSSEResponse](#parsesseresponse)
    - [createSSEStreamParser and parseSSEStream](#createssestreamparser-and-parsessestream)
    - [parseSSEEvents](#parsesseevents)
    - [parseSSEBuffer](#parsessebuffer)
    - [ParsedSSEEvent Type](#parsedsseevent-type)
  - [Testing SSE Routes](#testing-sse-routes)
  - [SSESessionSpy API](#ssesessionspy-api)
  - [SSE Rooms](#sse-rooms)
    - [Enabling Rooms](#enabling-rooms)
    - [Session Room Operations](#session-room-operations)
    - [Broadcasting to Rooms](#broadcasting-to-rooms)
    - [Room Event Publisher (Fire-and-Forget)](#room-event-publisher-fire-and-forget)
    - [`publish` vs `safePublish`](#publish-vs-safepublish)
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
    - [Which test client should I use?](#which-test-client-should-i-use)
    - [Detailed Comparison](#detailed-comparison)
    - [SSEHttpClient](#ssehttpclient)
    - [SSEInjectClient](#sseinjectclient)
    - [Contract-Aware Inject Helpers](#contract-aware-inject-helpers)
    - [Contract-Aware HTTP Helpers](#contract-aware-http-helpers)
    - [When a Handler Fails to Send an Event](#when-a-handler-fails-to-send-an-event)
- [Gateway Configuration](#gateway-configuration)
  - [Quick Start](#quick-start)
  - [Annotating Routes](#annotating-routes)
  - [Avoiding Repetition With Defaults](#avoiding-repetition-with-defaults)
  - [Type-Safe Matching](#type-safe-matching)
  - [Field Reference](#field-reference)
  - [Generating Gateway Configs](#generating-gateway-configs)
  - [Inspecting the Manifest at Runtime](#inspecting-the-manifest-at-runtime)
  - [Streaming Routes](#streaming-routes)
  - [What's Not Covered](#whats-not-covered)
- [Polling Fallback for SSE](#polling-fallback-for-sse)
  - [Serving the Pattern](#serving-the-pattern)
  - [SSE Rooms Authorization](#sse-rooms-authorization)
  - [Monotonic Event IDs](#monotonic-event-ids)
  - [Server-Side Guarantees Checklist](#server-side-guarantees-checklist)
- [Development](#development)

## Basic usage

Define a module, or several modules, that will be used for resolving dependency graphs, using awilix:

```ts
import { AbstractModule, type InferModuleDependencies, asSingletonClass, asMessageQueueHandlerClass, asEnqueuedJobWorkerClass, asJobQueueClass, asApiControllerClass } from 'opinionated-machine'

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
    // by DIContext.registerRoutes(); JSON, SSE and dual-mode routes alike
    resolveControllers(diOptions: DependencyInjectionOptions) {
        return {
            controller: asApiControllerClass(MyController),
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

A controller extends `AbstractApiController`, declares its contracts in a `static contracts` object and builds one route per contract with `buildApiRoute`. Contracts come from `defineApiContract` in `@lokalise/api-contracts`. The same controller can hold plain JSON routes, SSE routes and dual-mode routes; the response mode comes from the contract.

```ts
import { defineApiContract, noBodyResponse } from '@lokalise/api-contracts'
import { AbstractApiController, buildApiRoute } from 'opinionated-machine'
import { z } from 'zod/v4'

const getUserContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Get user',
  pathResolver: ({ userId }) => `/users/${userId}`,
  requestPathParamsSchema: z.object({ userId: z.string() }),
  responsesByStatusCode: {
    200: z.object({ id: z.string(), name: z.string() }),
    404: z.object({ message: z.string() }),
  },
})

const deleteUserContract = defineApiContract({
  visibility: 'public',
  method: 'delete',
  summary: 'Delete user',
  pathResolver: ({ userId }) => `/users/${userId}`,
  requestPathParamsSchema: z.object({ userId: z.string() }),
  responsesByStatusCode: { 204: noBodyResponse() },
})

export class UserController extends AbstractApiController<typeof UserController.contracts> {
  static contracts = {
    getUser: getUserContract,
    deleteUser: deleteUserContract,
  } as const

  private readonly userService: UserService

  constructor({ userService }: ModuleDependencies) {
    super()
    this.userService = userService
  }

  readonly routes = {
    getUser: buildApiRoute(UserController.contracts.getUser, async (request) => {
      const user = await this.userService.find(request.params.userId)
      if (!user) {
        return { status: 404, body: { message: 'User not found' } }
      }
      return { status: 200, body: user }
    }),

    deleteUser: buildApiRoute(UserController.contracts.deleteUser, async (request) => {
      await this.userService.delete(request.params.userId)
      return { status: 204, body: null }
    }),
  }
}
```

Handlers return `{ status, body }` and never call `reply.send()`; the response is validated against the contract before it is sent. The `routes` object must have one entry per key of `contracts`, which the class generic enforces.

Register the controller in the module's `resolveControllers()` with `asApiControllerClass`:

```ts
resolveControllers() {
  return {
    userController: asApiControllerClass(UserController),
  }
}
```

`DIContext` throws when a controller returned from `resolveControllers()` was registered with anything other than `asApiControllerClass`.

The full guide to the handler model, SSE and dual-mode routes, route options and testing is in [lib/api-contracts/docs.md](./lib/api-contracts/docs.md).

## Migrating from legacy contracts

Version 9 of `@lokalise/api-contracts` and version 8 of `@lokalise/fastify-api-contracts` removed the legacy contract builders (`buildRestContract`, `buildContract`, `buildSseContract`, ...) and `buildFastifyRoute`. This package dropped everything built on them. Define contracts with `defineApiContract` (SSE responses with `sseBody()` / `sseResponse()`), then replace the removed APIs as follows:

| Removed | Replacement |
| ------- | ----------- |
| `AbstractController`, `AbstractSSEController`, `AbstractDualModeController` | `AbstractApiController`. One controller holds JSON, SSE and dual-mode routes |
| `buildRoutes()`, `buildSSERoutes()`, `buildDualModeRoutes()`, `BuildRoutesReturnType` | a `readonly routes` object |
| `asControllerClass`, `asSSEControllerClass`, `asDualModeControllerClass` | `asApiControllerClass` |
| `buildFastifyRoute`, `buildHandler` (`sync` / `sse` handlers) | `buildApiRoute(contract, handler, options?)` with a single `(request, reply, { sse, expectedContentType }) => { status, body }` handler |
| `sse.respond(status, body)` | return `{ status, body }` before calling `sse.start()` |
| `defaultMode` on dual-mode routes | branch on `expectedContentType` in the handler |
| `DIContext.registerSSERoutes()`, `DIContext.registerDualModeRoutes()` | `DIContext.registerRoutes()`, which registers every route, SSE included |
| `asSSEControllerClass(..., { rooms: true })`, `session.rooms` | `buildApiRoute(contract, handler, { sseRooms: sseRoomBroadcaster })`, `getSessionRooms(session)` |
| Controller `broadcast()`, `broadcastToRoom()`, `sendEvent()`, `sendEventInternal()`, `getConnections()` | `SSERoomBroadcaster` / `SSERoomEventPublisher` for fan-out, `session.send()` inside the handler |
| Controller hooks `onConnectionEstablished` / `onConnectionClosed` | route options `onConnect` / `onClose` |
| `injectSSE`, `injectPayloadSSE` | `injectApiSSE` |
| `awaitServerConnection: { controller }`, `controller.connectionSpy` | `createSSESessionSpy()` and `awaitServerConnection: { spy }` |
| `DependencyInjectionOptions.isTestMode` | removed, nothing replaces it |
| `buildGatewayManifest({ includeStreamingControllers })` | removed. Every route is in the manifest |
| `SSEContractDefinition`, `DualModeContractDefinition`, `SSEEventSchemas` and the other legacy contract type re-exports | the types of `@lokalise/api-contracts` / `@lokalise/fastify-api-contracts` |

## Putting it all together

Typical usage with a fastify app looks like this:

```ts
import FastifySSEPlugin from '@fastify/sse'
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
    enqueuedJobWorkersEnabled: false,
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

// Only needed when a controller declares SSE routes
await app.register(FastifySSEPlugin)

app.after(() => {
    context.registerRoutes(app)
})
await app.ready()
```

`registerRoutes(app)` registers the routes of every controller from `resolveControllers()`, including SSE and dual-mode routes.

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

#### `asApiControllerClass(Type, opts?)`
For controllers extending `AbstractApiController`. Marks the dependency as **private** and tags it as an API controller, so `DIContext.registerRoutes()` registers its `routes`. Controllers are always singletons. Use in `resolveControllers()`; `DIContext` rejects controllers registered any other way.

```ts
resolveControllers() {
  return {
    userController: asApiControllerClass(UserController),
  }
}
```

### Message Queue Resolvers

#### `asMessageQueueHandlerClass(Type, mqOptions, opts?)`
For message queue consumers following `message-queue-toolkit` conventions. Automatically handles `start`/`close` lifecycle and respects `messageQueueConsumersEnabled` option. Consumers start concurrently with the other inits of their `asyncInitPriority` (see awilix-manager's `concurrent` option), so anything that needs a consumer to have started must use a higher `asyncInitPriority`. Pass `asyncInit: 'start'` in `opts` to start one without the `concurrent` flag. Requires `awilix-manager` 7.1.0 or later, including the copy used by `@fastify/awilix` when its `AwilixManager` is passed to `DIContext`.

```ts
messageQueueConsumer: asMessageQueueHandlerClass(MessageQueueConsumer, {
    queueName: MessageQueueConsumer.QUEUE_ID,
    diOptions,
})
```

### Background Job Resolvers

#### `asEnqueuedJobWorkerClass(Type, workerOptions, opts?)`
For enqueued job workers following `background-jobs-common` conventions. Automatically handles `start`/`dispose` lifecycle and respects `enqueuedJobWorkersEnabled` option. Workers start concurrently with the other inits of their `asyncInitPriority`, like message queue consumers. Pass `asyncInit: 'start'` in `opts` to start one without the `concurrent` flag.

```ts
jobWorker: asEnqueuedJobWorkerClass(JobWorker, {
    queueName: JobWorker.QUEUE_ID,
    diOptions,
})
```

#### `asPgBossProcessorClass(Type, processorOptions, opts?)`
For pg-boss job processor classes. Similar to `asEnqueuedJobWorkerClass` but uses `start`/`stop` lifecycle methods, initializes after pgBoss (priority 20) and starts processors one after another.

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

SSE routes are ordinary `AbstractApiController` routes whose contract declares an SSE response. Streaming runs on [@fastify/sse](https://github.com/fastify/sse); the route builder and handler model come from `@lokalise/fastify-api-contracts`. This section covers setup, the streaming patterns, rooms, subscriptions and test utilities. [lib/api-contracts/docs.md](./lib/api-contracts/docs.md) has the complete handler and route option reference.

### Prerequisites

Register the `@fastify/sse` plugin before `registerRoutes()` when any controller declares an SSE route:

```ts
import FastifySSEPlugin from '@fastify/sse'

const app = fastify()
await app.register(FastifySSEPlugin)
```

Plugin-level options apply to every SSE route. The heartbeat interval is set here and only
here - it is not a per-route option:

```ts
await app.register(FastifySSEPlugin, { heartbeatInterval: 30000 })
```

An app serving SSE routes **must** also register an SSE-aware error handler. An error thrown after the stream started reaches the global error handler with the stream still open and the headers already sent. A handler that always calls `reply.status().send()` fails with `ERR_HTTP_HEADERS_SENT`, and the stream never closes. On a live stream, send a terminal event and close the stream instead:

```ts
app.setErrorHandler(async (error, request, reply) => {
  const { statusCode, payload } = resolveError(error) // your error-to-response mapping
  // `isConnected` alone is not enough — @fastify/sse sets it before the handler runs.
  if (reply.sse?.isConnected && reply.raw.headersSent) {
    await reply.sse.send({ event: 'error', data: payload })
    reply.sse.close()
    return
  }
  return reply.status(statusCode).send(payload)
})
```

The `errorHandler` from `@lokalise/fastify-extras` handles live streams this way already.

### Defining SSE Routes

An SSE response is declared per status code, either as `sseResponse({ ... })` or as `sseBody({ ... })` inside a content map. A status whose content map carries both a JSON schema and an `sseBody` makes the route dual-mode (see [Dual-Mode Routes](#dual-mode-routes)).

```ts
import { defineApiContract, sseBody, sseResponse } from '@lokalise/api-contracts'
import { z } from 'zod/v4'

// GET stream with path params
export const channelStreamContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Stream channel messages',
  pathResolver: ({ channelId }) => `/api/channels/${channelId}/stream`,
  requestPathParamsSchema: z.object({ channelId: z.string() }),
  responsesByStatusCode: {
    200: sseResponse({ message: z.object({ content: z.string() }) }),
    404: z.object({ message: z.string() }),
  },
})

// POST stream (e.g., AI chat completions)
export const chatCompletionContract = defineApiContract({
  visibility: 'public',
  method: 'post',
  summary: 'Chat completion',
  pathResolver: () => '/api/chat/completions',
  requestBodySchema: z.object({ message: z.string() }),
  responsesByStatusCode: {
    200: {
      content: {
        'text/event-stream': sseBody({
          chunk: z.object({ content: z.string() }),
          done: z.object({ totalTokens: z.number() }),
        }),
      },
    },
  },
})
```

For contracts that declare an SSE response, the handler's third argument carries `sse`. `sse.start(mode)` sends the SSE headers and returns a session whose `send()` is typed by the contract's event schemas:

```ts
export class ChannelController extends AbstractApiController<typeof ChannelController.contracts> {
  static contracts = {
    channelStream: channelStreamContract,
    chatCompletion: chatCompletionContract,
  } as const

  private readonly channelService: ChannelService

  constructor({ channelService }: ModuleDependencies) {
    super()
    this.channelService = channelService
  }

  readonly routes = {
    channelStream: buildApiRoute(
      ChannelController.contracts.channelStream,
      async (request, _reply, { sse }) => {
        const channel = await this.channelService.find(request.params.channelId)
        if (!channel) {
          // Early HTTP response, before the stream starts
          return { status: 404, body: { message: 'Channel not found' } }
        }
        const session = sse.start('keepAlive')
        await session.send('message', { content: `Joined ${channel.name}` })
      },
    ),

    chatCompletion: buildApiRoute(
      ChannelController.contracts.chatCompletion,
      async (request, _reply, { sse }) => {
        const session = sse.start('autoClose')
        const words = request.body.message.split(' ')
        for (const word of words) {
          await session.send('chunk', { content: word })
        }
        await session.send('done', { totalTokens: words.length })
      },
    ),
  }
}
```

### Session Modes

The mode passed to `sse.start(mode)` decides when the connection closes:

- `'autoClose'` closes the connection when the handler returns. Use it for request-response streaming such as AI completions.
- `'keepAlive'` keeps the connection open after the handler returns, until the client disconnects or `session.close()` is called. Use it for notifications and live updates. Events pushed later, from outside the handler, reach the session through [rooms](#sse-rooms), or through a `session.send` reference the route stores itself in `onConnect` and drops in `onClose`.

To answer with a regular HTTP response instead of a stream (validation error, not found), return `{ status, body }` before calling `sse.start()`. After `sse.start()`, the handler returns nothing.

A handler can also stream declaratively: returning `{ status, body }` for a status whose representation is an SSE stream streams `body` as an `AsyncIterable` of `{ event, data }` messages, in `autoClose` mode:

```ts
buildApiRoute(contract, () => {
  async function* chunks() {
    yield { event: 'chunk' as const, data: { content: 'Hello' } }
    yield { event: 'done' as const, data: { totalTokens: 1 } }
  }
  return { status: 200, body: chunks() }
})
```

### SSE Session Methods

The session returned by `sse.start(mode)`:

| Member | Description |
| ------ | ----------- |
| `id` | Unique connection id |
| `request` / `reply` | The Fastify request and reply |
| `context` | Per-connection data passed as `sse.start(mode, { context })` |
| `send(event, data, options?)` | Send a typed event, validated against the contract schema. `options` takes `id` and `retry` |
| `sendStream(messages)` | Send messages from an `AsyncIterable`, validating each one |
| `isConnected()` | Whether the connection is still open |
| `getStream()` | The underlying writable stream |
| `close()` | Close the connection from the server side |

### Route Options

The third argument of `buildApiRoute` takes any Fastify route option except the ones the contract provides (`method`, `url`, `schema`, `handler`), plus these SSE options:

| Option | Description |
| ------ | ----------- |
| `onConnect` | Called with the session when the stream starts |
| `onClose` | Called with `(session, initiator)` when the connection closes. `initiator` is `'server'` (`session.close()`, or an `autoClose` handler returned) or `'client'` |
| `onReconnect` | Called with `(session, lastEventId)` when the client reconnects with `Last-Event-ID`. Return an iterable of events to replay, or replay them yourself |
| `serializer` | Custom serializer for event data (default `JSON.stringify`) |
| `heartbeat` | `false` disables the heartbeat comments on this route. The interval is set when registering `@fastify/sse` |
| `contractMetadataToRouteMapper` | Maps the contract's `metadata` to Fastify route options (`config`, `onRequest`, `preHandler`, ...). Explicit options override it; `config` objects are merged |
| `sseRooms` | Enables [SSE rooms](#sse-rooms) for the route |
| `gatewayMetadata` | Per-route gateway policy (see [Gateway Configuration](#gateway-configuration)) |

```ts
buildApiRoute(contract, handler, {
  preHandler: async (request, reply) => {
    if (!request.headers.authorization) {
      reply.code(401).send({ message: 'Unauthorized' })
    }
  },
  onConnect: (session) => session.request.log.info({ id: session.id }, 'connected'),
  onClose: (session, initiator) => session.request.log.info({ id: session.id, initiator }, 'closed'),
  onReconnect: async (session, lastEventId) => this.eventStore.since(lastEventId),
  heartbeat: false,
})
```

SSE-capable routes are registered with the `@fastify/sse` kind `'manual'`: the plugin does no `Accept` negotiation, so `reply.sse` is always attached and the handler decides whether to stream or return a regular response. Clients that send no `Accept: text/event-stream` (a wildcard, `application/json`, or no header at all) still reach the handler.

### Error Handling

- Errors thrown by a handler go to the app's `setErrorHandler`, on SSE routes too, and the route builder adds no error mapping of its own. Before the stream starts they take the regular HTTP error path. After it starts, the stream is still open when the error handler runs, so the handler has to send a terminal event and close the stream (see [Prerequisites](#prerequisites)).
- Errors thrown or rejected by `onConnect`, `onClose` and `onReconnect` are caught and logged on the request logger. The connection lifecycle continues.
- `session.send()` throws when the payload does not match the event schema. In tests, `injectApiSSE` and `connectApiSSE` report such failures with the event name and Zod issues (see [When a Handler Fails to Send an Event](#when-a-handler-fails-to-send-an-event)).
- Room broadcasts do not throw for a closed or failing connection. A send the session rejects is logged, that connection counts as not delivered, and the fan-out continues.

### Graceful Shutdown

SSE streams don't hold `app.close()`. For `buildApiRoute` routes registered through `registerRoutes`, a `preClose` 
hook runs before Fastify closes its HTTP server:

- keepAlive streams still open are closed. Left open, the server would wait for them, and no `onClose` hook, the DI 
 container dispose included, would run until the process was killed.
- autoClose streams still being generated are left to finish, like any in-flight request.
- idle keep-alive connections are closed as requests complete, so a response that finishes during shutdown doesn't 
 keep the server open until `keepAliveTimeout`.

### Dual-Mode Routes

A route is dual-mode when one success status declares both a JSON body and an SSE stream. The handler reads `expectedContentType`, the `Accept`-negotiated content type, and either returns JSON or starts a stream:

```ts
const chatContract = defineApiContract({
  visibility: 'public',
  method: 'post',
  summary: 'Chat',
  pathResolver: () => '/api/chat',
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

buildApiRoute(chatContract, async (request, _reply, { expectedContentType, sse }) => {
  if (expectedContentType === 'text/event-stream') {
    const session = sse.start('autoClose')
    for await (const chunk of this.aiService.stream(request.body.message)) {
      await session.send('chunk', { delta: chunk.text })
    }
    await session.send('done', {})
    return
  }
  const result = await this.aiService.complete(request.body.message)
  // A status with several media types needs an explicit contentType
  return { status: 200, contentType: 'application/json', body: { reply: result.text } }
})
```

Negotiation honours quality values and wildcards. Under a full wildcard (`Accept: */*`) the first content type the contract declares wins. `expectedContentType` is `null` when the request has no `Accept` header or accepts none of the declared types, and the handler picks the fallback (JSON in the example above).

To test the JSON side, use `app.inject()` or `injectByApiContract` from `@lokalise/fastify-api-contracts` with `accept: application/json`. To test the stream, use `injectApiSSE` (it always sends `accept: text/event-stream`). The [dual-mode testing section of docs.md](./lib/api-contracts/docs.md#testing-dual-mode-routes) has an example of each.

### SSE Parsing Utilities

Wire-format parsing lives in
[`@opinionated-machine/sse-parser`](../sse-parser/README.md) and is
re-exported here, so the server's test helpers and the browser client
(`@opinionated-machine/sse-fallback`) frame a stream with the same code.

| Function | Use case |
|----------|----------|
| `parseSSEResponse` | A `fetch` response: decodes the bytes and frames them for you |
| `parseSSEStream` | An async iterable of already-decoded text chunks |
| `createSSEStreamParser` | A stream you drive yourself, chunk by chunk |
| `parseSSEEvents` | Testing and request-response streaming, when the full body is in hand |
| `parseSSEBuffer` | The primitive the others are built on |

#### parseSSEResponse

Consume a live SSE stream from `fetch`. Multi-byte characters split across
network chunks are held back, and breaking out of the loop cancels the
response body.

```ts
import { parseSSEResponse } from 'opinionated-machine'

const response = await fetch(url, { headers: { accept: 'text/event-stream' } })

for await (const event of parseSSEResponse(response)) {
  console.log('Received:', event.event ?? 'message', JSON.parse(event.data))
  if (event.event === 'done') break
}
```

Unlike `EventSource` the request is yours: custom headers, a POST body, an
`AbortSignal`, your own reconnect policy.

#### createSSEStreamParser and parseSSEStream

When the transport hands you decoded text rather than a `Response`, or when you
need the reconnect cursor after the stream ends.

```ts
import { createSSEStreamParser } from 'opinionated-machine'

// One per connection: it holds the partial frame, the Last-Event-ID cursor and
// the BOM that may open the stream.
const parser = createSSEStreamParser({ lastEventId: resumeFrom })

for await (const chunk of chunks) {
  for (const event of parser.push(chunk)) {
    console.log('Received:', event.event ?? 'message', event.data)
  }
}

reconnectWith(parser.lastEventId)
```

`parseSSEStream` wraps that loop when you only want the events:

```ts
import { parseSSEStream } from 'opinionated-machine'

for await (const event of parseSSEStream(chunks, {
  onChunk: () => resetStaleConnectionTimer(),
})) {
  handle(event)
}
```

`onChunk` fires for every chunk before it is framed, comment frames included.
Framing consumes `: heartbeat` comments, so a consumer watching only events
cannot tell an idle-but-healthy connection from a dead one.

#### parseSSEEvents

Parse a complete SSE response body into an array of events.

**When to use:** testing with Fastify's `inject()`, or when the full response is
available (request-response style SSE such as OpenAI completions):

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

A trailing frame with no blank line after it is discarded, which is what the
spec requires at the end of a stream: a body cut mid-frame must not surface its
truncated payload as a delivered event. Reach for `parseSSEBuffer` when you want
to inspect that leftover.

#### parseSSEBuffer

One pass over a buffer: the events it completed, the bytes it could not, and the
reconnect cursor. Prefer `createSSEStreamParser` for a live stream, which keeps
all three across chunks for you.

```ts
import { parseSSEBuffer, type ParseSSEBufferResult } from 'opinionated-machine'

let buffer = ''
let cursor: string | undefined

for await (const chunk of stream) {
  buffer += chunk
  // Feeding the cursor back is what makes Last-Event-ID survive: an event with
  // no `id:` of its own inherits the previous one, and an `id:` frame carrying
  // no data still moves it.
  const result: ParseSSEBufferResult = parseSSEBuffer(buffer, cursor)
  buffer = result.remaining
  cursor = result.lastEventId

  for (const event of result.events) {
    console.log('Received:', event.event, event.data)
  }
}
```

#### ParsedSSEEvent Type

Every entry point returns events with this structure:

```ts
type ParsedSSEEvent = {
  id?: string           // The "id:" this event carried, if any
  event?: string        // Event type from "event:"; absent means 'message'
  data: string          // Event data from "data:", always present
  retry?: number        // Reconnection interval from "retry:"
  lastEventId?: string  // The reconnect cursor as of this event's dispatch
}
```

`id` and `lastEventId` are separate on purpose. The cursor persists across
events that carry no `id:` of their own, so it is what you reconnect with;
`id` is what the event itself carried, so it is what you order and deduplicate
on. Ordering on the cursor instead makes every inheriting event look like a
duplicate of the last id-bearing one.

### Testing SSE Routes

The test client depends on the session mode:

| Session Mode | Test Client | Why |
|-------------|-------------|--------|
| `autoClose` | `injectApiSSE` (or `SSEInjectClient` for raw URLs) | Handler completes and closes connection; all events available at once |
| `keepAlive` | `connectApiSSE` (or `SSEHttpClient` for raw URLs) | Connection stays open; events arrive incrementally via server push |

#### Testing autoClose SSE (request-response streaming)

`injectApiSSE(app, contract, params)` injects the request through Fastify, so no server has to listen. The HTTP method comes from the contract, and `params` has the shape `injectByApiContract` takes (`pathParams`, `queryParams`, `headers`, `body`, `pathPrefix`, each required only when the contract declares the matching schema):

```ts
import { defineApiContract, sseResponse } from '@lokalise/api-contracts'
import { z } from 'zod/v4'
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

it('streams the review', async () => {
  const { events } = injectApiSSE(app, lqaSegmentContract, { body: { segment: 'hello' } })

  // Events are validated against the contract and typed as a union on `event`.
  for (const event of await events()) {
    if (event.event === 'review') expect(event.data.score).toBeGreaterThan(0)
  }
})

it('returns the documented 400 body for an empty segment', async () => {
  const { bodyForStatus } = injectApiSSE(app, lqaSegmentContract, { body: { segment: '' } })

  // `body` is typed as `{ message: string }` — the contract's 400 schema.
  const body = await bodyForStatus(400)
  expect(body.message).toBe('segment must not be empty')
})
```

```ts
it('sends each issue as soon as it is found', async () => {
  const { head, stream } = injectApiSSE(app, lqaSegmentContract, { body: { segment: 'hello' } })

  // The head is on the wire as soon as the handler calls sse.start()
  expect((await head).statusCode).toBe(200)

  for await (const event of stream()) {
    // Each event is observed while the handler is still producing the next one
    if (event.event === 'issue') expect(handlerFinished).toBe(false)
  }
})
```

The result exposes:

- `closed`: resolves with `{ statusCode, headers, body }` once the response completes.
- `head`: `{ statusCode, headers }`, resolved as soon as the response head is on the wire (for a streaming handler, at `sse.start()`).
- `events()`: parses the SSE body and validates each event against the contract's SSE schemas. It throws when the response isn't a stream, when an event name isn't declared, or when a payload fails its schema.
- `stream(signal?)`: the same typed, validated events, yielded as the handler writes them. The request is injected with Fastify's `payloadAsStream`; events are buffered from the moment it is injected, so a generator started late replays the stream from its first event, a consumer that breaks early leaves `closed` / `events()` intact, and the handler is never blocked waiting to be read.
- `bodyForStatus(status)`: asserts the status, JSON-parses the body and validates it against the schema `responsesByStatusCode` declares for that status, following the same exact → range → `'default'` precedence as the contract client. It throws, with the status and a truncated body snippet, when any of those steps fails.
- `sendFailures()`: the send failures recorded for this request (see [When a Handler Fails to Send an Event](#when-a-handler-fails-to-send-an-event)).

`closed` and `events()` wait for the response to complete, so a route that never closes its stream (a `keepAlive` session) can only be read through `stream()`, or over real HTTP with [`connectApiSSE`](#contract-aware-http-helpers).

The request always carries `accept: text/event-stream`, so a status that declares a stream answers with it, including a dual-mode status whose content map also carries a JSON schema. Those statuses are therefore not callable through `bodyForStatus`; read them with `events()`, or use `injectByApiContract` for the JSON side. A contract that declares no SSE response at all types `events` as `never`, so calling it is a compile error rather than a guaranteed throw. `events()` is typed from the SSE schemas of *every* declared status, merged the same way the runtime merges them, so a contract streaming on both `200` and `'4xx'` yields the union of both event sets. See the [testing section of docs.md](./lib/api-contracts/docs.md#testing) for more.

#### Testing keepAlive SSE (long-lived connections)

A `keepAlive` response never completes, so it needs a real HTTP connection. The pattern:

1. Wire a session spy into the route with `createSSESessionSpy()` and connect with `awaitServerConnection: { spy }`, so the test gets the server-side session without racing the handler
2. Call `collectEvents()` **before** pushing events (they arrive asynchronously)
3. Push events from the server, through the session or a room broadcast
4. Await the collected events
5. Always call `client.close()` to release the connection

```ts
import { connectApiSSE, createSSESessionSpy, SSETestServer } from 'opinionated-machine'

describe('notifications stream', () => {
  const { spy, routeOptions } = createSSESessionSpy()
  let server: SSETestServer

  beforeAll(async () => {
    // The spy's hooks must reach the buildApiRoute() call, see below
    const app = await getApp({ notificationsRouteOptions: routeOptions })
    // SSETestServer.start() starts your app on a random port and provides baseUrl
    server = await SSETestServer.start(app)
  })

  afterAll(async () => {
    await server.close()
  })

  it('receives notifications over keepAlive SSE', async () => {
    const { client, serverConnection } = await connectApiSSE(
      server.baseUrl,
      notificationsContract,
      { queryParams: { userId: 'test-user' } },
      { awaitServerConnection: { spy } },
    )

    expect(client.response.ok).toBe(true)

    const eventsPromise = client.collectEvents(2)

    await serverConnection.send('notification', { id: '1', message: 'Hello!' })
    await serverConnection.send('notification', { id: '2', message: 'World!' })

    // Events are typed and validated against the contract
    expect(await eventsPromise).toMatchObject([
      { event: 'notification', data: { id: '1', message: 'Hello!' } },
      { event: 'notification', data: { id: '2', message: 'World!' } },
    ])

    client.close()
  })
})
```

### SSESessionSpy API

`createSSESessionSpy()` returns a spy plus the `onConnect` / `onClose` route hooks that drive it:

```ts
import { buildApiRoute, createSSESessionSpy, SSEHttpClient } from 'opinionated-machine'

const { spy, routeOptions } = createSSESessionSpy()

// in the app under test — `routeOptions` is just `{ onConnect, onClose }`
app.route(buildApiRoute(streamContract, handler, { ...routeOptions }))

// in the test — waits for the server-side session before resolving
const { client, serverConnection } = await SSEHttpClient.connect(baseUrl, '/api/stream', {
  awaitServerConnection: { spy },
})
await serverConnection.send('ping', { seq: 1 })
```

The spy can also be queried directly:

```ts
// Wait for a session to be established (with timeout)
const session = await spy.waitForConnection({ timeout: 5000 })

// Wait for a session matching a predicate (useful for multiple sessions)
const session = await spy.waitForConnection({
  timeout: 5000,
  predicate: (s) => s.request.url.includes('/api/notifications'),
})

// Check if a specific session is active
const isConnected = spy.isConnected(sessionId)

// Wait for a specific session to disconnect
await spy.waitForDisconnection(sessionId, { timeout: 5000 })

// Get all session events (connect/disconnect history)
const events = spy.getEvents()

// Clear event history and claimed sessions between tests
spy.clear()
```

**Note**: `waitForConnection` tracks "claimed" sessions internally. Each call returns a unique unclaimed session, allowing sequential waits for the same URL path without returning the same session twice. `awaitServerConnection` uses it the same way.

**The hooks have to reach the `buildApiRoute()` call itself.** `buildApiRoute` captures `onConnect` / `onClose` when it builds the handler, so assigning them to the `RouteOptions` object it returns does nothing — the connect would just time out:

```ts
// Does NOT work: the route was already built without the hooks
const route = controller.routes.streamUpdates
Object.assign(route, routeOptions) // no-op as far as SSE lifecycle hooks go
```

A route owned by a controller therefore has to accept SSE route options for a test to be able to spy on it. Take them as a dependency and pass them through:

```ts
export class StreamController extends AbstractApiController<typeof StreamController.contracts> {
  static contracts = { streamUpdates: streamUpdatesContract } as const

  readonly routes: Record<keyof typeof StreamController.contracts, RouteOptions>

  constructor({ sseRouteOptions }: StreamControllerDependencies) {
    super()
    this.routes = {
      streamUpdates: buildApiRoute(
        StreamController.contracts.streamUpdates,
        this.streamUpdates,
        sseRouteOptions,
      ),
    }
  }
}

// production wiring registers no hooks; the test registers the spy's
const { spy, routeOptions } = createSSESessionSpy()
const controller = new StreamController({ sseRouteOptions: routeOptions })
```

If the route already declares lifecycle hooks of its own, use `withSpy()` rather than spreading `routeOptions` over them — spreading silently drops one side or the other, depending on the order. `withSpy()` keeps the route's hook (it runs first, and the spy is notified once it settles) and passes every other option through:

```ts
const { spy, withSpy } = createSSESessionSpy()

app.route(
  buildApiRoute(streamContract, handler, withSpy({
    heartbeat: false,
    onConnect: (connection) => subscriptions.add(connection.id),
  })),
)
```

**`keepAlive` sessions only.** An `autoClose` route closes its session as the handler returns, and `waitForConnection` only hands back sessions that are still open, since a closed one can no longer be sent events. Awaiting such a connection races and usually times out (with an error that says as much) — omit `awaitServerConnection` for `autoClose` routes and assert on the events the client received instead.

The spy is typed for the `SSESession` of `@lokalise/fastify-api-contracts`, which is what `buildApiRoute` passes to its hooks.

### SSE Rooms

SSE Rooms provide Socket.IO-style room functionality for grouping connections and broadcasting messages to specific groups. Common use cases include:

- **Multi-tenant systems** - Broadcast announcements to all users within an organization or team
- **Live dashboards** - Multiple users viewing the same dashboard join a room to receive real-time metric updates
- **Stock tickers** - Users subscribe to specific symbols; each symbol is a room receiving price updates
- **Sports/game scores** - Users following specific matches join those rooms for live score updates

#### Enabling Rooms

Register the room infrastructure once, in any module's `resolveDependencies()`, and inject the broadcaster into the controllers that need it. A route opts in by passing the broadcaster as the `sseRooms` route option:

```ts
import { asValue } from 'awilix'
import type { RouteOptions } from 'fastify'
import {
  AbstractApiController,
  AbstractModule,
  asApiControllerClass,
  asSingletonClass,
  buildApiRoute,
  getSessionRooms,
  SSERoomBroadcaster,
  SSERoomManager,
} from 'opinionated-machine'

class DashboardModule extends AbstractModule {
  resolveDependencies() {
    return {
      // Registered once, shared by every route that uses rooms
      sseRoomManager: asValue(new SSERoomManager()),
      sseRoomBroadcaster: asSingletonClass(SSERoomBroadcaster), // expects 'sseRoomManager' in cradle — name must match exactly
    }
  }

  resolveControllers() {
    return {
      dashboardController: asApiControllerClass(DashboardController),
    }
  }
}

class DashboardController extends AbstractApiController<typeof DashboardController.contracts> {
  static contracts = { dashboardStream: dashboardStreamContract } as const

  readonly routes: Record<keyof typeof DashboardController.contracts, RouteOptions>

  constructor({ sseRoomBroadcaster }: { sseRoomBroadcaster: SSERoomBroadcaster }) {
    super()
    // Built in the constructor: a field initializer would run before the
    // broadcaster is available to pass as an option
    this.routes = {
      dashboardStream: buildApiRoute(
        DashboardController.contracts.dashboardStream,
        (request, _reply, { sse }) => {
          const session = sse.start('keepAlive')
          getSessionRooms(session).join(`dashboard:${request.params.dashboardId}`)
        },
        { sseRooms: sseRoomBroadcaster },
      ),
    }
  }
}
```

With `sseRooms`, each session opened by the route is registered with the broadcaster, receives broadcasts for the rooms it joined, and is cleaned up (rooms left, dedup cache cleared) when the connection closes. Without it, `getSessionRooms(session)` returns no-ops and the session receives no broadcasts.

`sseRooms` also accepts an options object, `{ broadcaster, authorizeJoin?, maxSessionLifetimeMs? }`, for a per-route scope check on joins and a bounded session lifetime. See [SSE Rooms Authorization](#sse-rooms-authorization).

#### Session Room Operations

`getSessionRooms(session)` returns the room operations of a session opened by an `sseRooms` route:

```ts
const session = sse.start('keepAlive')
const rooms = getSessionRooms(session)

// Join one or more rooms
rooms.join(`dashboard:${request.params.dashboardId}`)
rooms.join(['org:acme', 'plan:enterprise']) // Multiple rooms

// Leave rooms
rooms.leave('plan:enterprise')
```

#### Broadcasting to Rooms

`SSERoomBroadcaster` is a shared, non-generic service, so domain services (use cases, event handlers, message queue consumers) receive it from DI and broadcast directly. Events are declared with `defineEvent()`, which types the payload:

```ts
import { defineEvent, type SSERoomBroadcaster } from 'opinionated-machine'
import { z } from 'zod/v4'

const metricsUpdateEvent = defineEvent(
  'metricsUpdate',
  z.object({ cpu: z.number(), memory: z.number() }),
)

class MetricsService {
  private broadcaster: SSERoomBroadcaster

  constructor(deps: { sseRoomBroadcaster: SSERoomBroadcaster }) {
    this.broadcaster = deps.sseRoomBroadcaster
  }

  async onMetricsUpdate(dashboardId: string, metrics: { cpu: number; memory: number }) {
    // Returns the number of local connections the event was delivered to
    const count = await this.broadcaster.broadcastToRoom(
      `dashboard:${dashboardId}`,
      metricsUpdateEvent,
      metrics,
    )
  }

  async announceFeature(flag: string) {
    // Several rooms: a connection in more than one of them receives the event once
    await this.broadcaster.broadcastToRoom(['premium', 'beta-testers'], featureFlagEvent, {
      flag,
      enabled: true,
    })
  }

  async localAnnouncement(room: string, message: string) {
    // Skip adapter (Redis) propagation in multi-node setups
    await this.broadcaster.broadcastToRoom(room, announcementEvent, { message }, { local: true })
  }
}
```

`broadcastToRoom(room, event, data, options?)` takes `id` and `retry` in its options as well, and generates a random `id` when none is given. `broadcastMessage(room, message, options?)` sends a raw `SSEMessage` and returns `{ delivered, filtered }`. The event must also be declared in the SSE schemas of the route's contract: the session validates every message it sends, and a broadcast it rejects is logged and counted as not delivered.

#### Room Event Publisher (Fire-and-Forget)

`broadcastToRoom()` returns a promise, and most producers of a room event have nothing to do with
it. An event listener or message queue handler has already committed its primary work by the time
it broadcasts: it cannot retry a dropped hint, has nowhere to report one, and awaiting the fan-out
would tie its latency to the number of open connections. `SSERoomEventPublisher` is the broadcaster
without the promise.

```ts
import { defineEvent, SSERoomEventPublisher } from 'opinionated-machine'
import { z } from 'zod/v4'

const metricsUpdateEvent = defineEvent(
  'metricsUpdate',
  z.object({ cpu: z.number(), memory: z.number() }),
)

// Register alongside the broadcaster it wraps; it expects 'sseRoomBroadcaster' and 'logger'
// in the cradle, so the names must match exactly.
class DashboardModule extends AbstractModule {
  resolveDependencies() {
    return {
      sseRoomManager: asValue(new SSERoomManager()),
      sseRoomBroadcaster: asSingletonClass(SSERoomBroadcaster),
      sseRoomEventPublisher: asSingletonClass(SSERoomEventPublisher),
      metricsService: asSingletonClass(MetricsService),
    }
  }
}

class MetricsService {
  private publisher: SSERoomEventPublisher

  constructor(deps: { sseRoomEventPublisher: SSERoomEventPublisher }) {
    this.publisher = deps.sseRoomEventPublisher
  }

  onMetricsUpdate(
    dashboardId: string,
    metrics: { cpu: number; memory: number },
    requestContext: RequestContext,
  ) {
    // No await: a failure is logged, not returned. The context is passed whole; only its
    // logger is read, so a dropped event carries the correlation id of whatever produced it.
    this.publisher.publish(
      `dashboard:${dashboardId}`,
      metricsUpdateEvent,
      metrics,
      requestContext,
    )
  }
}
```

The context parameter is typed as `SSELogContext` (`{ logger: SSELogger }`) rather than any
concrete context type, so `@lokalise/fastify-extras`' `RequestContext` satisfies it structurally
and this package needs no dependency on it. A job or consumer context of your own works the same
way, and a caller that has none omits the argument and falls back to the injected logger.

Two things it does beyond hiding the promise:

- **Validates before broadcasting, and throws.** A payload that violates its own event schema is
  a bug in the producer, and nobody receives the event, so dropping it quietly means believing
  you published something you did not. Delivery-time validation cannot give you this: it runs
  once per connection, so it reports the mismatch once per open connection on every node, names
  the event but not the code that produced it, does not run at all when nobody has joined the
  room, and by then the call has long returned.
- **Puts the parsed value on the wire,** so a schema default is filled in once here rather than
  left to every client. Delivery-time validation discards its own result and serializes what it
  was handed, so `broadcastToRoom()` sends the unparsed input.

#### `publish` vs `safePublish`

They differ in one thing: what a malformed payload does.

| | malformed payload | failed broadcast |
| --- | --- | --- |
| `publish` | throws `InternalError` | logged |
| `safePublish` | returns `{ error }`, and logs | logged |

Reach for `safePublish` in a producer that cannot absorb a throw: a message handler whose primary
work has already committed would be retried in full and redo it, and the retry cannot succeed
anyway, since a malformed payload fails the same way every time. Prefer `publish` everywhere
else.

```ts
const outcome = this.publisher.safePublish(room, event, payload, requestContext)
if (outcome.error) {
  // decide for yourself: metric, Bugsnag, a compensating write
}
```

`{ result: true }` means the payload was validated and handed to the broadcaster. That is
acceptance, not delivery: the fan-out has not run yet, and neither method reports its outcome,
because it happens after the call has returned. Use the broadcaster directly when the delivered
count matters, or when a failed delivery is something the caller can act on.

#### Room Name Helpers

Room names are plain strings (like Socket.IO), but `defineRoom()` adds type-safe resolvers that keep naming consistent between routes and domain services:

```ts
import { defineRoom } from 'opinionated-machine'

// Define typed room name resolvers
const dashboardRoom = defineRoom<{ dashboardId: string }>(
  ({ dashboardId }) => `dashboard:${dashboardId}`,
)

const projectChannelRoom = defineRoom<{ projectId: string; channelId: string }>(
  ({ projectId, channelId }) => `project:${projectId}:channel:${channelId}`,
)

// In the route handler — params are type-checked
getSessionRooms(session).join(dashboardRoom({ dashboardId: request.params.dashboardId }))

// In a domain service — same resolver, same type safety
await broadcaster.broadcastToRoom(dashboardRoom({ dashboardId }), metricsUpdateEvent, metrics)
```

`defineRoom()` is a zero-overhead identity wrapper — it simply returns the function you pass in, typed as `RoomNameResolver<TParams>`. The value is purely at compile time: typos in room name patterns become type errors, and refactoring a room's naming scheme only requires changing one place.

#### Room Query Methods

The broadcaster answers the common queries; the underlying `SSERoomManager` (`broadcaster.roomManager`) has the rest:

```ts
// Connection ids in a room, and their count
broadcaster.getConnectionsInRoom(`dashboard:${dashboardId}`)
broadcaster.getConnectionCountInRoom(`dashboard:${dashboardId}`)

// Rooms a connection is in, membership checks, all rooms on this node
broadcaster.roomManager.getRooms(connectionId)
broadcaster.roomManager.isInRoom(connectionId, room)
broadcaster.roomManager.getAllRooms()

// Join or leave on behalf of a connection (e.g., admin operations)
broadcaster.roomManager.leave(connectionId, fromRoom)
broadcaster.roomManager.join(connectionId, toRoom)
```

Joining through `roomManager` directly bypasses the route's `authorizeJoin` check. To end a connection's stream or remove it from a room as a revocation, use the registry described in [SSE Rooms Authorization](#sse-rooms-authorization).

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
```

Routes need no change: they keep passing the same broadcaster as `sseRooms`.

The Redis adapter uses Pub/Sub for cross-node message propagation. When you call `broadcastToRoom()`, the message is published to Redis and delivered to all nodes that have connections in that room.

See the [@opinionated-machine/sse-rooms-redis](../sse-rooms-redis/README.md) package for detailed documentation on Redis adapter configuration and usage.

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

Wire `handleConnect` and `handleDisconnect` into the route's `onConnect` / `onClose` hooks, and pass the broadcaster as `sseRooms`:

```typescript
class NotificationController extends AbstractApiController<typeof NotificationController.contracts> {
  static contracts = { notificationStream: notificationStreamContract } as const

  readonly routes: Record<keyof typeof NotificationController.contracts, RouteOptions>

  private readonly subscriptionManager: SSESubscriptionManager<UserCtx, EventMetadata>
  // onConnect is not awaited by the route builder, see below
  private readonly pendingConnects = new Map<string, Promise<void>>()

  constructor(deps: Dependencies) {
    super()
    this.subscriptionManager = deps.subscriptionManager

    this.routes = {
      notificationStream: buildApiRoute(
        NotificationController.contracts.notificationStream,
        (_request, _reply, { sse }) => {
          sse.start('keepAlive')
        },
        {
          onConnect: (session) => this.connect(session),
          onClose: (session) => this.disconnect(session),
          // Required: registers the session with the broadcaster
          sseRooms: deps.sseRoomBroadcaster,
        },
      ),
    }
  }

  private connect(session: SSESession): Promise<void> {
    const connected = this.subscriptionManager.handleConnect(session)
    // Must not reject, so that disconnect still runs after a failed connect
    const settled = connected
      .catch(() => {})
      .finally(() => this.pendingConnects.delete(session.id))
    this.pendingConnects.set(session.id, settled)
    return connected // a rejection is logged by the route
  }

  private async disconnect(session: SSESession): Promise<void> {
    await this.pendingConnects.get(session.id)
    this.subscriptionManager.handleDisconnect(session)
  }
}
```

- `sseRooms` is required. The manager joins rooms on `SSERoomManager` directly, and `sseRooms` is what registers the session's sender with the broadcaster. Without it, nothing is delivered.
- The route builder does not await `onConnect`, so the client can close while `handleConnect` is still running the resolver chain. `onClose` waits for the in-flight connect before calling `handleDisconnect`; otherwise the connect would finish after the disconnect and leave a managed entry behind.
- Rooms joined by the manager bypass the `sseRooms.authorizeJoin` check. The resolvers are the authorization for those rooms.

`SSESession` here is the type from `@lokalise/fastify-api-contracts`. `test/sse/fixtures/subscriptionFixtures.ts` has a working version of this wiring.

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
| `autoClose` | `injectApiSSE` or `SSEInjectClient` | Handler completes and closes connection; all events available at once |
| `keepAlive` | `connectApiSSE` or `SSEHttpClient` | Connection stays open; events arrive incrementally via server push |

`injectApiSSE` and `SSEInjectClient` both use Fastify inject; `injectApiSSE` takes the contract and returns typed, validated events, while `SSEInjectClient` works with raw URLs and unparsed event data. `connectApiSSE` and `SSEHttpClient` have the same relationship over real HTTP.

#### Detailed Comparison

| Feature | Inject (`injectApiSSE`, `SSEInjectClient`) | HTTP (`connectApiSSE`, `SSEHttpClient`) |
|---------|--------------------------------------------|------------------------------------------|
| **Connection** | Fastify's `inject()` - in-memory | Real HTTP via `fetch()` |
| **Event delivery** | All events returned at once (after handler closes) | Events arrive incrementally |
| **Connection lifecycle** | Handler must close for request to complete | Can stay open indefinitely |
| **Server requirement** | No `listen()` needed | Requires a listening server (`SSETestServer.start(app)` or manual `app.listen()`) |
| **Request body** | `body` param / `connectWithBody` | `body` param / `method` + `body` connect options |
| **Assertions before the handler finishes** | `injectApiSSE`'s `head` / `stream()` (`SSEInjectClient` buffers the whole response) | `client.response` is available as soon as headers arrive |
| **Best for** | `autoClose` SSE (OpenAI-style, batch exports) | `keepAlive` SSE (notifications, live feeds, rooms), streams whose headers must be asserted mid-handler |
| **Dual-mode sync** | Use `app.inject()` with `accept: 'application/json'` | Same |

#### SSEHttpClient

For testing `keepAlive` SSE connections using real HTTP, and for any assertion that has to happen on the wire while the handler is still running. Supports `GET`, `POST`, `PUT` and `PATCH`. Requires a listening server — use `SSETestServer.start(app)` to start your app on a random port:

```ts
import { createSSESessionSpy, SSEHttpClient } from 'opinionated-machine'

// The spy's routeOptions are passed to the route's buildApiRoute() call
const { spy, routeOptions } = createSSESessionSpy()

// Connect to SSE endpoint with awaitServerConnection (recommended)
// This eliminates the race condition between client connect and server-side registration
const { client, serverConnection } = await SSEHttpClient.connect(
  server.baseUrl,
  '/api/stream',
  {
    query: { userId: 'test' },
    headers: { authorization: 'Bearer token' },
    awaitServerConnection: { spy },
  },
)

// serverConnection is the server-side session, ready to use immediately
expect(client.response.ok).toBe(true)
await serverConnection.send('test', {})

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
- Testing against external SSE endpoints (not your own routes)
- Routes you cannot pass the spy's hooks to
- Simple smoke tests that only verify response headers/status without sending server events
- Routes whose handler starts an `autoClose` session: it closes as the handler returns, so there is no live session left to wait for — assert on the received events instead

**Consequence**: Without `awaitServerConnection`, `connect()` resolves as soon as HTTP headers are received. Server-side connection registration may not have completed yet, so you cannot reliably send events from the server immediately after `connect()` returns.

```ts
// Example: smoke test that only checks connection works
const client = await SSEHttpClient.connect(server.baseUrl, '/api/stream')
expect(client.response.ok).toBe(true)
expect(client.response.headers.get('content-type')).toContain('text/event-stream')
client.close()
```

**POST/PUT/PATCH endpoints**

`connect()` also issues non-GET requests, so SSE endpoints that take a request body can be tested over real HTTP. Pass `method` and `body`. The method is accepted in either case, so the lowercase spelling your contracts already use (`method: 'post'`) works as-is:

```ts
const client = await SSEHttpClient.connect(server.baseUrl, '/api/chat/completions', {
  method: 'POST',
  body: { message: 'Hello', stream: true },
})

const events = await client.collectEvents((event) => event.event === 'done')
```

Bodies `fetch()` can send natively — strings, `URLSearchParams`, `FormData`, `Blob`/`File`, `ArrayBuffer`, typed arrays (`Buffer`, `Uint8Array`, …) and `ReadableStream` — are passed through untouched; anything else is JSON-stringified. `content-type: application/json` is defaulted for JSON-stringified and string bodies (so a raw string stays verbatim, which is handy for asserting on malformed payloads), unless you provide your own content type. Payloads that describe their own encoding — `URLSearchParams`, `FormData`, `Blob` — keep the content type `fetch()` gives them:

```ts
// Sent as application/x-www-form-urlencoded, not JSON-stringified into `{}`
const client = await SSEHttpClient.connect(server.baseUrl, '/api/chat/completions', {
  method: 'post',
  body: new URLSearchParams({ message: 'Hello' }),
})
```

A body without a non-GET `method` throws — `fetch()` cannot attach one to a GET request.

**Asserting on the wire before the handler finishes**

`connect()` resolves as soon as HTTP headers arrive, and `client.response` is populated at that point. That is what makes the "open the stream before the slow work starts" behaviour testable: assert on status and headers while the handler is still awaiting its slow call, then let it proceed.

```ts
// Handler calls sse.start() and only then makes its slow LLM call
const client = await SSEHttpClient.connect(server.baseUrl, '/api/chat/completions', {
  method: 'POST',
  body: { message: 'Hello', stream: true },
})

// Already on the wire while the LLM call is still in flight
expect(client.response.status).toBe(200)
expect(client.response.headers.get('content-type')).toContain('text/event-stream')

releaseSlowCall()
const events = await client.collectEvents((event) => event.event === 'done')
```

The mirror case works too: a failure raised *before* `sse.start()` reaches the client as the JSON status the contract declares, not as a terminal `error` event. The response body is only locked once you start consuming events, so it can still be read as JSON:

```ts
const client = await SSEHttpClient.connect(server.baseUrl, '/api/chat/completions', {
  method: 'POST',
  body: { message: 'Hello', stream: true },
})

expect(client.response.status).toBe(503)
expect(client.response.headers.get('content-type')).not.toContain('text/event-stream')
expect(await client.response.json()).toEqual({ message: 'Upstream unavailable' })
```

Read that body *before* `close()`: closing aborts the request, so a body read after it (or from a `finally { client.close() }` block that runs first) rejects with an `AbortError`.

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

// Any other method inject() accepts works too - the option is typed as
// `SSEInjectMethod`, exported so you never have to redeclare that union
const conn = await client.connectWithBody(
  '/api/exports/42',
  { reason: 'cleanup' },
  { method: 'DELETE' },
)

// All events are available immediately (inject waits for handler to complete)
expect(conn.getStatusCode()).toBe(200)
const events = conn.getReceivedEvents()
const chunks = events.filter(e => e.event === 'chunk')
```

When the route answers with a status code *before* streaming starts (auth failure,
validation error, integration unavailable), it sends a JSON body rather than events.
`getBody()` returns that body raw and `json()` parses it, mirroring Fastify's own
inject response:

```ts
const conn = await client.connect('/api/export/progress')

expect(conn.getStatusCode()).toBe(503)
expect(conn.json<{ errorCode: string }>()).toMatchObject({
  errorCode: 'INTEGRATION_NOT_AVAILABLE',
})
```

`json()` throws if the body is empty or isn't valid JSON, so it only makes sense for
these pre-stream responses - a `text/event-stream` body is not JSON. For contract-typed
tests, `injectApiSSE` offers `bodyForStatus(status)`, which also validates the body against
the contract's schema for that status.

#### Contract-Aware Inject Helpers

`injectApiSSE(app, contract, params)` is the contract-typed counterpart of `SSEInjectClient`: the method, path, query params, headers and body come from the contract, and `events()` / `stream()` return events validated against the contract's SSE schemas. See [Testing autoClose SSE](#testing-autoclose-sse-request-response-streaming).

#### Contract-Aware HTTP Helpers

`connectApiSSE` is the real-HTTP counterpart of `injectApiSSE`: the same typed, validated event union, over a connection that can stay open. Use it for `keepAlive` routes, whose response never completes, and wherever a suite needs a real socket.

```ts
import { connectApiSSE, SSETestServer } from 'opinionated-machine'

const server = await SSETestServer.start(app)

// Method, path, query params, headers and body all come from the contract
const client = await connectApiSSE(server.baseUrl, lqaSegmentContract, {
  body: { segment: 'hello' },
})

expect(client.response.status).toBe(200) // asserted while the handler is still working

for await (const event of client.events()) {
  if (event.event === 'issue') expect(event.data.severity).toBe('minor') // typed by the contract
  if (event.event === 'review') break
}

client.close()
await server.close()
```

- `client.events(signal?)` and `client.collectEvents(countOrPredicate, timeout?)` mirror `SSEHttpClient`'s readers, with each event validated against the contract's SSE schemas and typed as a union on `event` — the predicate sees the narrowed type too, and is invoked exactly once per event.
- Both readers reject a response that isn't an event stream (a documented `400`/`401` raised before `sse.start()`, say) with its status and body, rather than reporting a stream that produced no events. `client.response` is still readable afterwards, so the JSON body can be asserted.
- `client.response` is the fetch `Response`, available before any event is consumed.
- `client.raw` is the underlying `SSEHttpClient`, for anything this wrapper doesn't cover.
- Pass `{ awaitServerConnection: { spy } }` as a fourth argument (with a spy from `createSSESessionSpy()`) to also wait for the server-side session of a `keepAlive` route; the call then resolves to `{ client, serverConnection }`.

On a connection you already have, the same typing is available per read: `client.apiEvents(contract)` and `client.collectApiEvents(contract, countOrPredicate)` on any `SSEHttpClient`.

#### When a Handler Fails to Send an Event

`session.send(name, payload)` validates the payload against the contract's schema for that event and throws when it doesn't match. The throw happens inside the handler: the event never reaches the wire, the stream ends early (with HTTP 200, and possibly a terminal `error` event from the app's error handler), and the Zod error only lands in the server log — leaving the test to explain an event that is simply missing.

Routes built with `buildApiRoute` report those failures to whichever helper is reading the stream. When the failure is what cut the stream short — nothing caught it — `events()`, `stream()` and the `connectApiSSE` readers throw with the offending event name, its Zod issues and the rejected payload. That includes a stream that then ended with an `error` event the contract does not declare, sent by an SSE-aware error handler:

```
events() — 1 SSE send failure recorded for this request:
  - event "issue" was never sent: severity: Invalid option: expected one of "neutral"|"minor"|"major"|"critical"; payload: {"severity":"min"}
```

A failure the route *recovered* from does not fail the read. A handler that catches its own best-effort send and streams a fallback instead produced exactly the response it meant to, so the readers deliver it and record the failure as context; the same goes for a `sendStream()` source that throws while producing its next message, which is reported as the source failing rather than blamed on the last event that did reach the client.

Both `injectApiSSE(...).sendFailures()` and `connectApiSSE(...).sendFailures()` return every record (`{ eventName?, data?, message, issues?, error, handled }`) — including the recovered ones — for assertions the thrown message doesn't cover:

```ts
const { closed, events, sendFailures } = injectApiSSE(app, lqaSegmentContract, { body })
await closed

expect(await events()).toHaveLength(2) // the fallback stream is intact
expect(sendFailures()).toMatchObject([{ eventName: 'issue', handled: true }])
```

This is test-only and costs production traffic nothing: the helpers tag their requests with an `x-om-sse-diagnostics-id` header, and a session is instrumented only when that header names a diagnostics scope open in the same process — something only those helpers create. A stale or forged header matches nothing.

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
| Envoy   | [`@opinionated-machine/gateway-envoy`](../gateway-envoy)     | static v3 YAML/JSON |
| KrakenD | [`@opinionated-machine/gateway-krakend`](../gateway-krakend) | declarative v3 JSON |
| Kong    | [`@opinionated-machine/gateway-kong`](../gateway-kong)       | DB-less declarative YAML/JSON |

### Quick Start

A complete round-trip in two steps. First, annotate routes in your existing
controller:

```ts
import { defineApiContract } from '@lokalise/api-contracts'
import type { RouteOptions } from 'fastify'
import {
  AbstractApiController,
  buildApiRoute,
  type GatewayMetadataValue,
} from 'opinionated-machine'
import { z } from 'zod/v4'

const getUser = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Get user',
  requestPathParamsSchema: z.object({ userId: z.string() }),
  pathResolver: ({ userId }) => `/users/${userId}`,
  responsesByStatusCode: { 200: z.object({ id: z.string() }) },
})
const createUser = defineApiContract({
  visibility: 'public',
  method: 'post',
  summary: 'Create user',
  requestBodySchema: z.object({ name: z.string() }),
  pathResolver: () => '/users',
  responsesByStatusCode: { 201: z.object({ id: z.string() }) },
})

export class UsersController extends AbstractApiController<typeof UsersController.contracts> {
  static readonly contracts = { getUser, createUser } as const

  // Applies to every route in this controller; routes can override.
  override readonly gatewayDefaults: GatewayMetadataValue = {
    upstream: 'users-service',
    timeouts: { request: '5s' },
    auth: { required: true },
  }

  readonly routes = {
    getUser: buildApiRoute(UsersController.contracts.getUser, async (req) => /* … */, {
      gatewayMetadata: { cache: { ttl: '60s' } },
    }),
    createUser: buildApiRoute(UsersController.contracts.createUser, async (req) => /* … */, {
      gatewayMetadata: { rateLimit: { requests: 10, per: '1m', key: 'ip' } },
    }),
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

Pass `gatewayMetadata` inline via the `buildApiRoute` options argument:

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

Or, to keep gateway annotations in one block separate from route
construction, wrap a built route with `withGatewayMetadata(contract, route, metadata)`:

```ts
import { withGatewayMetadata } from 'opinionated-machine'

const c = UsersApiController.contracts

readonly routes = {
  getUser:    withGatewayMetadata(c.getUser,    buildApiRoute(c.getUser, this.getUser),       { cache: { ttl: '60s' } }),
  createUser: withGatewayMetadata(c.createUser, buildApiRoute(c.createUser, this.createUser), { rateLimit: { requests: 10, per: '1m', key: 'ip' } }),
  deleteUser: buildApiRoute(c.deleteUser, this.deleteUser), // no per-route policy; inherits defaults
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
const getUser = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Get user',
  requestHeaderSchema: z.object({ 'x-trace-id': z.string() }),
  requestPathParamsSchema: z.object({ userId: z.string() }),
  pathResolver: ({ userId }) => `/users/${userId}`,
  responsesByStatusCode: { 200: ResponseBody },
})

withGatewayMetadata(getUser, buildApiRoute(getUser, this.getUser), {
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
| `timeouts` | `{ request: '5s', idle: '60s', connect: '1s' }` | Duration units: `ms` / `s` / `m` / `h`. `idle` maps to Envoy route `idle_timeout`, joins Kong's loosest-wins `read_timeout`, and raises KrakenD's endpoint `timeout` — declare it on streaming routes to bound liveness (pair with heartbeats) |
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
| `tags` | `tags: ['users']` | Documentation / partitioning |
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

- [`@opinionated-machine/gateway-envoy`](../gateway-envoy/README.md)
- [`@opinionated-machine/gateway-krakend`](../gateway-krakend/README.md)
- [`@opinionated-machine/gateway-kong`](../gateway-kong/README.md)

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

### Streaming Routes

SSE and dual-mode routes need gateway treatment that request-response routes
must not get: Envoy's defaults (15s route timeout, 5-minute stream idle
timeout) reset long-lived streams, and buffering proxies hold SSE frames until
the response completes. Routes built from SSE-capable contracts are therefore
stamped with a streaming mode, and the manifest carries it as
`streaming: 'sse' | 'dual'`.

The marker describes the **success path**. An error status answers with a JSON
body on a streaming route too (including a handler that returns
`{ status: 404, body }` before starting the stream), so generators size
timeouts and buffering from it but must not assume the content type of a
failure.

- **Envoy** — streaming routes default to `timeout: 0s` and `idle_timeout: 0s`
  (declare `timeouts.idle` to reinstate a liveness bound; heartbeats are the
  intended keep-alive). `EnvoyOptions.streamIdleTimeout` sets the listener-wide
  HCM `stream_idle_timeout` for everything else. Declaring `timeouts.request`
  on an SSE-only route warns — it bounds the stream's total lifetime.

  With both of those timeouts off, a streaming route would otherwise have an
  **unbounded** lifetime, and the authorization checked when the stream opened
  would stay in force for as long as the connection lives — a principal removed
  from a scope keeps receiving events until they close the tab. Streaming
  routes therefore emit a route-level `max_stream_duration`, defaulting to
  30 minutes. Configure it with `EnvoyOptions.maxStreamDuration` (`'off'` for
  the old unbounded behaviour) or per route with `timeouts.maxDuration`
  (`'0s'` to opt out). The ceiling is invisible to users when the client
  treats a server close as a routine reconnect, which
  `@opinionated-machine/sse-fallback` does.

  A **dual-mode** route is emitted as *two* Envoy routes, because one route
  cannot be both: `<id>__sse`, matched on `Accept: text/event-stream`, and
  `<id>`, the catch-all. The declared timeouts are split between them rather
  than applied to both — `timeouts.idle` goes to the stream branch,
  `timeouts.request` to the JSON branch, which is the fallback poll path and
  the one that most needs a bound. The split keys off the `Accept` header,
  quality values included: `text/event-stream;q=0` is a refusal, so it takes
  the JSON branch.

  A route whose fallback branch is the stream inverts the split, because there
  the server streams for a missing or wildcard `Accept` header. The manifest
  carries the fallback branch as `streamingDefaultMode` (`'non-sse' | 'sse'`,
  the `@lokalise/api-contracts` vocabulary). `buildApiRoute` does not set it;
  stamp it with `attachRouteStreamingMode(route, 'dual', 'sse')` on a route
  whose handler streams when `expectedContentType` is `null`. Envoy then makes the
  stream the catch-all with `<id>__json` as the narrow branch, so an
  unspecific request cannot land on the JSON branch's request timeout while the
  server is streaming. A request listing both media types resolves to JSON on
  the server but takes the stream branch at the gateway; the renderer warns
  about that residual ambiguity.
- **Kong** — streaming routes emit `response_buffering: false` (Kong ≥ 2.3);
  `timeouts.idle` joins the loosest-wins service `read_timeout`. Streaming
  routes without a declared idle warn: heartbeats must arrive within the
  effective `read_timeout` (Kong default 60s) or the stream is reset.

  Kong CE's `read_timeout` is **service-level**, so a long streaming idle
  window loosens every route sharing that upstream. Each co-located
  non-streaming route that inherits a raised timeout is warned about by name;
  give streaming routes their own `metadata.upstream` when the plain routes
  beside them need to stay tightly bounded.
- **KrakenD** — the endpoint `timeout` uses the looser of `timeouts.request` /
  `timeouts.idle`; streaming routes with neither warn about KrakenD's 2s
  default endpoint timeout.

Every route of every registered controller is included in the manifest,
streaming routes included.

### What's Not Covered

- **Fields a particular gateway can't natively express.** They show up in
  `result.warnings` rather than disappearing. Reach for `extensions.<vendor>`
  to hand-write the missing piece on a per-route basis.
- **Runtime drift detection.** The manifest is built from your code; the
  gateway runs separately. The generators don't compare deployed gateway
  state against the manifest.


## Polling Fallback for SSE

Push channels fail silently: connections die without an error event, proxies
kill idle streams, a broadcast misses a rebalancing room. When the missed
notification gates workflow progress ("upload finished"), the user is stuck.

[`@opinionated-machine/sse-fallback`](../sse-fallback/README.md) is a
browser-safe, zero-dependency client core that makes **polling the correctness
backbone** and SSE the latency optimization: the client subscribes to the SSE
branch of a dual-mode route and keeps a deadman timer — when no data event
arrives within the window, it polls the JSON branch of the same route. A
version gate reconciles the two channels so app code sees exactly one uniform
event stream:

```ts
// Shared contracts module — the binding is the reconciliation declaration
export const uploadStatusBinding = defineFallbackBinding(uploadStatusContract, {
  // Polling can carry this on its own: the snapshot is a real route
  snapshotSource: 'endpoint',
  snapshotToEvents: (s) =>
    s.status === 'completed' ? [{ event: 'uploadFinished', data: { result: s.result } }] : [],
  version: { ofSnapshot: (s) => s.version },
  terminalEvents: ['uploadFinished', 'uploadFailed'],
})

// Client — identical result whether it traveled over SSE, replay, or a poll
const sub = createResilientSubscription(uploadStatusBinding, { transport, params })
const { result } = await sub.waitFor('uploadFinished')
```

See the [package README](../sse-fallback/README.md) for the state
machine, reconciliation semantics, hydration (initial load + live updates),
and the transport interface.

### Serving the Pattern

One dual-mode `AbstractApiController` route serves both channels — the sync
branch answers the fallback polls, the SSE branch joins a room that the domain
service broadcasts into. Build the routes in the constructor, so the injected
broadcaster is available when the `sseRooms` option is evaluated:

```ts
constructor({ jobs, sseRoomBroadcaster }: Dependencies) {
  super()
  this.jobs = jobs
  this.routes = {
    jobStatus: buildApiRoute(
      JobController.contracts.jobStatus,
      (request, _reply, { expectedContentType, sse }) => {
        // The push channel: join the job's room and stay open
        if (expectedContentType === 'text/event-stream') {
          const session = sse.start('keepAlive')
          getSessionRooms(session).join(`job:${request.params.jobId}`)
          return
        }
        // The fallback poll: return the current snapshot with its version
        return {
          status: 200,
          contentType: 'application/json',
          body: this.jobs.get(request.params.jobId),
        }
      },
      {
        // enables room membership + broadcast delivery for this route's sessions
        sseRooms: sseRoomBroadcaster,
      },
    ),
  }
}
```

```ts
// Domain service — broadcast with a monotonic id so clients can order events
await this.sseRoomBroadcaster.broadcastToRoom(`job:${jobId}`, doneEvent, { result }, {
  id: String(job.version),
})
```

### SSE Rooms Authorization

Room membership decides who receives a broadcast, so it is an authorization
boundary. The handler above names the room from a path param; nothing in that
line checks that the authenticated principal belongs to the job's scope. Pass
an options object instead of the bare broadcaster to declare the check once
per route:

```ts
{
  sseRooms: {
    broadcaster: this.sseRoomBroadcaster,
    // Refused joins are logged and dropped; the stream itself stays open.
    authorizeJoin: (session, room) => this.membership.canRead(session.request.user, room),
    // Close the session after 30 minutes, forcing a re-authorized reconnect.
    maxSessionLifetimeMs: 30 * 60_000,
  },
}
```

A synchronous verdict is applied before `join()` returns; an async one is
applied when it resolves, so the session joins a moment later and the client's
reconciliation poll covers anything broadcast in between.

Authorization checked at connect goes stale, so revocation needs a termination
path of its own:

```ts
const registry = getApiSseConnectionRegistry(this.sseRoomBroadcaster)

registry.evict(connectionId)                  // end one stream
registry.evictFromRoom(room, connectionId)    // drop one scope, keep the stream
registry.closeRoom(`project:${projectId}`)    // end every stream in a scope
```

Only connections on the current node are closed, so a revocation event has to
reach every node. A client that reconnects (as
`@opinionated-machine/sse-fallback` does) comes back through the route's own
authorization, so evicting a still-authorized principal costs a reconnect
rather than a broken surface — which is also why `maxSessionLifetimeMs` is
cheap: it doubles as the token-refresh mechanism and the backstop for a
revocation that never reached `evict()`.

`test/api-contracts/api.rooms.security.e2e.spec.ts` is the pattern to copy per
endpoint: a negative cross-tenant join test, and a mid-stream revocation test.

### Monotonic Event IDs

`Last-Event-ID` replay, client-side ordering, and the fallback version gate
all need event ids a client can ORDER, not just deduplicate. Use
`createEventIdSequence()` (one sequence per ordering scope — per room, per
resource):

```ts
import { compareEventIds, createEventIdSequence } from 'opinionated-machine'

const seq = createEventIdSequence()
await broadcaster.broadcastToRoom(room, statusEvent, data, { id: seq.next() })

// Ids order lexicographically within an epoch; across epochs (e.g. after a
// process restart) compareEventIds returns undefined — clients resync via poll
compareEventIds('e1-000000000001', 'e1-000000000002') // -1
```

**Prefer a domain version** (`job.version`, a revision column) over a generated
sequence whenever the resource has one: it is per-scope and writer-independent
for free, and the snapshot body has to carry it anyway for the client's version
gate.

`createEventIdSequence()` is in-memory and per-process, which makes it safe
only for a **single-writer** ordering scope. Its epoch defaults to the process
start time, and the client's default extractor orders by epoch first. If two
pods of the same service broadcast into the same room, each with its own
sequence, their epochs differ: the events interleave, the client's watermark
lands on the newer epoch, and every subsequent event from the older-epoch pod
compares as stale and is **silently dropped**. The failure only shows up under
horizontal scale, so it reaches production.

For a multi-writer scope use a domain version, a fixed shared `epoch` with a
`start` handed out from shared storage, or the Redis-backed sequence:

```ts
import { createRedisEventIdSequence } from '@opinionated-machine/sse-rooms-redis'

// One counter per ordering scope, shared by every pod — one INCR per id.
const seq = createRedisEventIdSequence({ client: redis, key: `sse:seq:job:${jobId}` })
await broadcaster.broadcastToRoom(room, statusEvent, data, { id: await seq.next() })
```

A shared counter orders **allocation**, not delivery. Between `next()` and the
broadcast a writer can be descheduled while another pod allocates the next id
and publishes first, so the client sees the higher id and drops the lower one
as stale. What to do about it depends on what the events carry:

- **Replacement-safe events** (the payload describes the state of the scope,
  or the id is a domain version read in the same transaction that wrote it):
  nothing. The dropped event is superseded by the one that overtook it, which
  is what the version gate is for.
- **Delta events applied to client state** (`state.apply`): the drop is a real
  loss. Serialize allocation and publication per ordering scope — one writer
  per scope, or a per-scope lock or outbox that publishes in id order.

Either way, call `next()` immediately before the broadcast with nothing awaited
in between: the window that reorders is exactly that gap.

### Server-Side Guarantees Checklist

For a resource to participate in the fallback pattern:

1. **Required** — a monotonic version per resource, present in both the
   snapshot body and each event, and truthful: a snapshot at version *v*
   reflects every event ≤ *v* (publish events after commit; read committed
   state in the poll handler). Snapshots must **subsume** prior events.
2. **Recommended** — stamp the SSE `id:` with that version; the client's
   default version extraction (bare integers and `createEventIdSequence()`
   ids alike) and `Last-Event-ID` replay then compose free. Make sure the id
   source is safe for the number of writers the scope has — see
   [Monotonic Event IDs](#monotonic-event-ids).
3. **Recommended** — a short heartbeat interval (~15s, configured once via
   `app.register(fastifySSE, { heartbeatInterval })`) so clients detect
   silently dead connections fast; correctness holds without heartbeats
   (polls bound staleness), detection latency improves with them.
4. Optional — dense (consecutive) versions enable client gap detection;
   `onReconnect` replay lets clients skip the post-reconnect poll
   (`replay: 'trusted'` in the binding).
5. Gateway — declare `timeouts.idle` on streaming routes (or rely on the
   streaming-route defaults) so proxies don't reset quiet streams; see
   [Streaming Routes](#streaming-routes).
6. Authorization — room membership decides who receives a broadcast, so it is
   an authorization boundary. Declare the scope check once per route with
   `sseRooms.authorizeJoin` rather than trusting every handler body, give
   sessions a `maxSessionLifetimeMs` so a check made at connect cannot stay in
   force forever, and call `getApiSseConnectionRegistry(broadcaster).evict()` /
   `.closeRoom()` when access is revoked mid-stream. See
   [SSE Rooms Authorization](#sse-rooms-authorization).

## Development

Tasks are orchestrated by [Turborepo](https://turborepo.dev), which reads the workspace graph from
`turbo.jsonc`:

```bash
pnpm run build:all              # build every package in dependency order
pnpm run lint:all               # biome + tsc in every package
pnpm exec turbo run test:ci     # this package's suite with coverage
```

Run these from the workspace root. Start with `build:all` on a fresh clone: the per-package
`build`, `lint` and `test` scripts each do one package's work and assume their workspace
dependencies are already built, so `pnpm run build` on its own fails until the graph has been
built once.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full task table and caching notes.

