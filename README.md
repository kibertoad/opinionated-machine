# opinionated-machine
Very opinionated DI framework for fastify, built on top of awilix

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

