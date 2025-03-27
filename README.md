# opinionated-machine
Very opinionated DI framework for fastify, built on top of awilix

## Basic usage

Define a module, or several modules:

```ts
import { AbstractModule } from 'opinionated-machine'

export type ModuleDependencies = {
    service: Service
    messageQueueConsumer: MessageQueueConsumer
    jobWorker: JobWorker
    queueManager: QueueManager
}

export class MyModule extends AbstractModule<ModuleDependencies, ExternalDependencies> {
    resolveDependencies(
        options: DependencyInjectionOptions,
        _externalDependencies: ExternalDependencies,
    ): MandatoryNameAndRegistrationPair<ModuleDependencies> {
        return {
            testService: asSingletonClass(Service),

            // by default init and disposal methods from `message-queue-toolkit` consumers
            // will be assumed. If different values are necessary, pass second config object
            // and specify "asyncInit" and "asyncDispose" fields
            messageQueueConsumer: asMessageQueueHandlerClass(MessageQueueConsumer, {
                queueName: MessageQueueConsumer.QUEUE_ID,
                messageQueueConsumersEnabled: options.messageQueueConsumersEnabled,
            }),

            // by default init and disposal methods from `background-jobs-commons` job workers
            // will be assumed. If different values are necessary, pass second config object
            // and specify "asyncInit" and "asyncDispose" fields
            jobWorker: asJobWorkerClass(JobWorker, {
                queueName: JobWorker.QUEUE_ID,
                jobWorkersEnabled: options.jobWorkersEnabled,
            }),

            // by default disposal methods from `background-jobs-commons` job queue manager
            // will be assumed. If different values are necessary, specify "asyncDispose" fields 
            // in the second config object
            queueManager: asJobQueueClass(
                QueueManager,
                {
                    jobQueuesEnabled: options.jobQueuesEnabled,
                },
                {
                    asyncInit: (manager) => manager.start(resolveJobQueuesEnabled(options)),
                },
            ),
        }
    }

    // controllers will be automatically registered on fastify app
    resolveControllers(): MandatoryNameAndRegistrationPair<unknown> {
        return {
            testController: asControllerClass(TestController),
        }
    }
}
```

## Defining controllers

Controllers require using fastify-api-contracts and are automatically registered to fastify app.

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

export class MyController extends AbstractController<typeof TestController.contracts> {
  public static contracts = { deleteItem: contract } as const

  public buildRoutes() {
    return {
      deleteItem: buildFastifyNoPayloadRoute(
          MyController.contracts.deleteItem,
        async (req, reply) => {
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
