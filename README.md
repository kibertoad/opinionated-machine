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
            jobWorker: asJobWorkerClass(JobWorker, {
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
import { z } from 'zod'
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

  public buildRoutes() {
    return {
      deleteItem: buildFastifyNoPayloadRoute(
          MyController.contracts.deleteItem,
        async (req, reply) => { // I would suggest using/mentioning api contracts here
          req.log.info(req.params.userId)
          await reply.status(204).send()
        },
      ),
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

const context = new DIContext<ModuleDependencies>(container, {
    messageQueueConsumersEnabled: [MessageQueueConsumer.QUEUE_ID],
    jobQueuesEnabled: false,
    jobWorkersEnabled: false,
    periodicJobsEnabled: false,
})

context.registerDependencies({
    modules: [module],
    {} // dependency overrides if necessary, usually for testing purposes
})

const app = fastify()
app.setValidatorCompiler(validatorCompiler)
app.setSerializerCompiler(serializerCompiler)

app.after(() => {
    context.registerRoutes(app)
})
await app.ready()
```
