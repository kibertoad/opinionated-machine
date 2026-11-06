import { injectByApiContract } from '@lokalise/fastify-api-contracts'
import { asClass, asFunction, createContainer, type NameAndRegistrationPair } from 'awilix'
import { fastify } from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { describe, expect, it } from 'vitest'
import { AbstractModule, type MandatoryNameAndRegistrationPair } from '../lib/AbstractModule.js'
import { type DependencyInjectionOptions, DIContext } from '../lib/DIContext.js'
import {
  asEnqueuedJobWorkerClass,
  asMessageQueueHandlerClass,
  asPgBossProcessorClass,
} from '../lib/resolverFunctions.js'
import { TestController } from './TestController.js'
import {
  JobWorker,
  PeriodicJob,
  TestMessageQueueConsumer,
  TestModule,
  type TestModuleDependencies,
  TestService,
  TestService2,
} from './TestModule.js'
import {
  TestModuleSecondary,
  type TestModuleSecondaryDependencies,
  type TestModuleSecondaryPublicDependencies,
} from './TestModuleSecondary.js'

function createTestContainer<T extends object = TestModuleDependencies>() {
  return createContainer<T>({
    injectionMode: 'PROXY',
  })
}

// biome-ignore lint/complexity/noBannedTypes: it's ok
type Config = {}

function createContext<TargetDependencies extends object = TestModuleDependencies>(
  dependencyOverrides?: NameAndRegistrationPair<TargetDependencies>,
  options: DependencyInjectionOptions = {},
  secondaryModules: AbstractModule<unknown>[] = [],
): DIContext<TargetDependencies, Config> {
  const module = new TestModule()
  const container = createTestContainer<TargetDependencies>()
  const context = new DIContext<TargetDependencies, Config>(container, options, {})

  context.registerDependencies(
    {
      modules: [module],
      secondaryModules,
      dependencyOverrides,
    },
    undefined,
  )
  return context
}

type Deferred = { promise: Promise<void>; resolve: () => void }

function createDeferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

// Lets every pending init or dispose that can make progress do so, without relying on timers
async function flushLifecycle() {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve()
  }
}

type Events = string[]

function createDeferredClass(name: string, events: Events, deferred: Deferred | undefined) {
  return class {
    static readonly QUEUE_ID = name
    start() {
      return Promise.resolve()
    }
    async close() {
      events.push(`${name}:start`)
      await deferred?.promise
      events.push(`${name}:end`)
    }
    async dispose() {
      await this.close()
    }
    async stop() {
      await this.close()
    }
  }
}

function createLifecycleContext(
  resolvers: NameAndRegistrationPair<object>,
  options: DependencyInjectionOptions = {},
) {
  class DisposeModule extends AbstractModule<object> {
    resolveDependencies() {
      return resolvers
    }
  }
  const context = new DIContext<object, object>(
    createContainer({ injectionMode: 'PROXY' }),
    options,
    {},
  )
  context.registerDependencies({ modules: [new DisposeModule()] }, undefined)
  return context
}

describe('opinionated-machine', () => {
  describe('registerDependencies', () => {
    it('injects service from a module', () => {
      const context = createContext()

      const testService = context.diContainer.cradle.testService
      expect(testService).toBeInstanceOf(TestService)
    })

    it('injects service override from a module', () => {
      const context = createContext({
        testService: asClass(TestService2),
      })

      const testService = context.diContainer.cradle.testService
      expect(testService).toBeInstanceOf(TestService2)
    })

    it('services default to singleton', () => {
      const context = createContext()

      const testService = context.diContainer.cradle.testService
      testService.counter++

      const testService2 = context.diContainer.cradle.testService
      expect(testService2.counter).toBe(1)
    })

    it('service overrides default to singleton', () => {
      const context = createContext({
        testService: asClass(TestService2),
      })

      const testService = context.diContainer.cradle.testService
      testService.counter++

      const testService2 = context.diContainer.cradle.testService
      expect(testService2.counter).toBe(1)
    })

    it('expendables default to transient', () => {
      const context = createContext()

      const testService = context.diContainer.cradle.testExpendable
      testService.counter++

      const testService2 = context.diContainer.cradle.testExpendable
      expect(testService2.counter).toBe(0)
    })

    it('expendables overrides default to transient', () => {
      const context = createContext({
        testExpendable: asClass(TestService2, {
          lifetime: 'TRANSIENT',
        }),
      })

      const testService = context.diContainer.cradle.testExpendable
      testService.counter++

      const testService2 = context.diContainer.cradle.testExpendable
      expect(testService2.counter).toBe(0)
    })
  })

  describe('registerRoutes', () => {
    it('registers defined routes', async () => {
      const context = createContext()

      const app = fastify()
      app.setValidatorCompiler(validatorCompiler)
      app.setSerializerCompiler(serializerCompiler)

      app.after(() => {
        context.registerRoutes(app)
      })
      await app.ready()

      const response = await injectByApiContract(app, TestController.contracts.deleteItem, {
        pathParams: {
          userId: '1',
        },
      })

      expect(response.statusCode).toBe(200)
    })

    it('rejects controllers not registered with asApiControllerClass', () => {
      class PlainControllerModule extends AbstractModule<object> {
        resolveDependencies() {
          return {}
        }

        override resolveControllers(): MandatoryNameAndRegistrationPair<unknown> {
          return { plainController: asClass(TestController) }
        }
      }
      const context = new DIContext<object, Config>(createTestContainer<object>(), {}, {})

      expect(() =>
        context.registerDependencies({ modules: [new PlainControllerModule()] }, undefined),
      ).toThrow('Controller "plainController" must be registered with asApiControllerClass()')
    })
  })

  describe('message queue consumers', () => {
    it('registers message queue consumers, by default they are disabled', async () => {
      const context = createContext()
      const { messageQueueConsumer } = context.diContainer.cradle

      expect(messageQueueConsumer.isStarted).toBe(false)
      await context.init()
      expect(messageQueueConsumer.isStarted).toBe(false)

      await context.destroy()
      expect(messageQueueConsumer.isStarted).toBe(false)
    })

    it('registers message queue consumers, enabled explicitly', async () => {
      const context = createContext(
        {},
        {
          messageQueueConsumersEnabled: [TestMessageQueueConsumer.QUEUE_ID],
        },
      )
      const { messageQueueConsumer } = context.diContainer.cradle

      expect(messageQueueConsumer.isStarted).toBe(false)
      await context.init()
      expect(messageQueueConsumer.isStarted).toBe(true)

      await context.destroy()
      expect(messageQueueConsumer.isStarted).toBe(false)
    })
  })

  describe('queue workers', () => {
    it('registers queue workers, by default they are disabled', async () => {
      const context = createContext()
      const { jobWorker } = context.diContainer.cradle

      expect(jobWorker.isStarted).toBe(false)
      await context.init()
      expect(jobWorker.isStarted).toBe(false)

      await context.destroy()
      expect(jobWorker.isStarted).toBe(false)
    })

    it('registers queue workers, enabled explicitly', async () => {
      const context = createContext(
        {},
        {
          enqueuedJobWorkersEnabled: [JobWorker.QUEUE_ID],
        },
      )
      const { jobWorker } = context.diContainer.cradle

      expect(jobWorker.isStarted).toBe(false)
      await context.init()
      expect(jobWorker.isStarted).toBe(true)

      await context.destroy()
      expect(jobWorker.isStarted).toBe(false)
    })
  })

  describe('job queues', () => {
    it('registers queues, by default they are disabled', async () => {
      const context = createContext()
      const { queueManager } = context.diContainer.cradle

      expect(queueManager.startedQueues).toHaveLength(0)
      await context.init()
      expect(queueManager.startedQueues).toHaveLength(0)

      await context.destroy()
      expect(queueManager.startedQueues).toHaveLength(0)
    })

    it('registers queues, enabled explicitly', async () => {
      const context = createContext(
        {},
        {
          jobQueuesEnabled: [JobWorker.QUEUE_ID],
        },
      )
      const { queueManager } = context.diContainer.cradle

      expect(queueManager.startedQueues).toHaveLength(0)
      await context.init()
      expect(queueManager.startedQueues).toHaveLength(1)

      await context.destroy()
      expect(queueManager.startedQueues).toHaveLength(0)
    })
  })

  describe('domain event emitter', () => {
    it('is disposed on destroy', async () => {
      const context = createContext()
      const { eventEmitter } = context.diContainer.cradle

      await context.init()
      expect(eventEmitter.isDisposed).toBe(false)

      await context.destroy()
      expect(eventEmitter.isDisposed).toBe(true)
    })
  })

  describe('periodic jobs', () => {
    it('registers periodic jobs, by default they are disabled', async () => {
      const context = createContext()
      const { periodicJob } = context.diContainer.cradle

      expect(periodicJob.isStarted).toBe(false)
      await context.init()
      expect(periodicJob.isStarted).toBe(false)

      await context.destroy()
      expect(periodicJob.isStarted).toBe(false)
    })

    it('registers periodic jobs, enabled explicitly', async () => {
      const context = createContext(
        {},
        {
          periodicJobsEnabled: [PeriodicJob.JOB_NAME],
        },
      )
      const { periodicJob } = context.diContainer.cradle

      expect(periodicJob.isStarted).toBe(false)
      await context.init()
      expect(periodicJob.isStarted).toBe(true)

      await context.destroy()
      expect(periodicJob.isStarted).toBe(false)
    })
  })

  describe('secondary modules', () => {
    it('resolves public dependencies from a secondary module', async () => {
      const context = createContext<TestModuleDependencies & TestModuleSecondaryPublicDependencies>(
        {},
        {},
        [new TestModuleSecondary()],
      )

      const { testServiceSecondary } = context.diContainer.cradle

      await testServiceSecondary.execute()
    })

    it('does not resolve private dependency from a secondary module', () => {
      const context = createContext<TestModuleDependencies & TestModuleSecondaryDependencies>(
        {},
        {},
        [new TestModuleSecondary()],
      )

      expect(() => context.diContainer.cradle.testRepository).toThrowError(/Could not resolve/)
    })

    it('resolves transitive dependencies from a secondary module', async () => {
      const context = createContext<TestModuleDependencies & TestModuleSecondaryPublicDependencies>(
        {},
        {},
        [new TestModuleSecondary()],
      )

      const { testServiceWithTransitive } = context.diContainer.cradle

      await testServiceWithTransitive.execute()
    })
  })

  describe('lifecycle', () => {
    it('closes consumers and disposes workers concurrently, holding back higher priorities until they finish', async () => {
      const events: Events = []
      const consumerA = createDeferred()
      const consumerB = createDeferred()
      const workerA = createDeferred()
      const workerB = createDeferred()
      const diOptions = {
        messageQueueConsumersEnabled: ['consumerA', 'consumerB'],
        enqueuedJobWorkersEnabled: ['workerA', 'workerB'],
      }
      const context = createLifecycleContext(
        {
          consumerA: asMessageQueueHandlerClass(
            createDeferredClass('consumerA', events, consumerA),
            {
              queueName: 'consumerA',
              diOptions,
            },
          ),
          consumerB: asMessageQueueHandlerClass(
            createDeferredClass('consumerB', events, consumerB),
            {
              queueName: 'consumerB',
              diOptions,
            },
          ),
          workerA: asEnqueuedJobWorkerClass(createDeferredClass('workerA', events, workerA), {
            queueName: 'workerA',
            diOptions,
          }),
          workerB: asEnqueuedJobWorkerClass(createDeferredClass('workerB', events, workerB), {
            queueName: 'workerB',
            diOptions,
          }),
          connection: asFunction(() => ({}), {
            asyncDispose: () => {
              events.push('connection')
              return Promise.resolve()
            },
            asyncDisposePriority: 20,
          }),
        },
        diOptions,
      )
      await context.init()

      const destroyed = context.destroy()
      await flushLifecycle()
      // both consumers are closing at the same time, nothing of a higher priority has started
      expect(events).toEqual(['consumerA:start', 'consumerB:start'])

      consumerB.resolve()
      await flushLifecycle()
      expect(events).toEqual(['consumerA:start', 'consumerB:start', 'consumerB:end'])

      consumerA.resolve()
      await flushLifecycle()
      // workers dispose together only once every consumer has closed
      expect(events).toEqual([
        'consumerA:start',
        'consumerB:start',
        'consumerB:end',
        'consumerA:end',
        'workerA:start',
        'workerB:start',
      ])

      workerA.resolve()
      workerB.resolve()
      await destroyed
      // the higher priority dispose runs only after both workers are done
      expect(events.slice(6)).toEqual(['workerA:end', 'workerB:end', 'connection'])
    })

    it('stops pg-boss processors only after message queue consumers have closed', async () => {
      const events: Events = []
      const consumer = createDeferred()
      const diOptions = {
        messageQueueConsumersEnabled: ['consumer'],
        enqueuedJobWorkersEnabled: ['processor'],
      }
      const context = createLifecycleContext(
        {
          // registered first, so a shared priority would start its stop alongside the consumer close
          processor: asPgBossProcessorClass(createDeferredClass('processor', events, undefined), {
            queueName: 'processor',
            diOptions,
          }),
          consumer: asMessageQueueHandlerClass(createDeferredClass('consumer', events, consumer), {
            queueName: 'consumer',
            diOptions,
          }),
        },
        diOptions,
      )
      await context.init()

      const destroyed = context.destroy()
      await flushLifecycle()
      expect(events).toEqual(['consumer:start'])

      consumer.resolve()
      await destroyed
      expect(events).toEqual(['consumer:start', 'consumer:end', 'processor:start', 'processor:end'])
    })

    it('caps concurrent disposes with maxDisposeConcurrency', async () => {
      const events: Events = []
      const consumerA = createDeferred()
      const consumerB = createDeferred()
      const diOptions = { messageQueueConsumersEnabled: ['consumerA', 'consumerB'] }
      const context = createLifecycleContext(
        {
          consumerA: asMessageQueueHandlerClass(
            createDeferredClass('consumerA', events, consumerA),
            {
              queueName: 'consumerA',
              diOptions,
            },
          ),
          consumerB: asMessageQueueHandlerClass(
            createDeferredClass('consumerB', events, consumerB),
            {
              queueName: 'consumerB',
              diOptions,
            },
          ),
        },
        { ...diOptions, maxDisposeConcurrency: 1 },
      )
      await context.init()

      const destroyed = context.destroy()
      await flushLifecycle()
      expect(events).toEqual(['consumerA:start'])

      consumerA.resolve()
      consumerB.resolve()
      await destroyed
      expect(events).toEqual([
        'consumerA:start',
        'consumerA:end',
        'consumerB:start',
        'consumerB:end',
      ])
    })

    it('caps concurrent inits with maxInitConcurrency', async () => {
      const events: Events = []
      const consumerA = createDeferred()
      const consumerB = createDeferred()
      const startingClass = (name: string, deferred: Deferred) =>
        class {
          async start() {
            events.push(`${name}:start`)
            await deferred.promise
            events.push(`${name}:end`)
          }
          close() {
            return Promise.resolve()
          }
        }
      const diOptions = { messageQueueConsumersEnabled: ['consumerA', 'consumerB'] }
      const context = createLifecycleContext(
        {
          consumerA: asMessageQueueHandlerClass(startingClass('consumerA', consumerA), {
            queueName: 'consumerA',
            diOptions,
          }),
          consumerB: asMessageQueueHandlerClass(startingClass('consumerB', consumerB), {
            queueName: 'consumerB',
            diOptions,
          }),
        },
        { ...diOptions, maxInitConcurrency: 1 },
      )

      const initialized = context.init()
      await flushLifecycle()
      expect(events).toEqual(['consumerA:start'])

      consumerA.resolve()
      consumerB.resolve()
      await initialized
      expect(events).toEqual([
        'consumerA:start',
        'consumerA:end',
        'consumerB:start',
        'consumerB:end',
      ])
    })

    it('keeps disposing later priorities when onDisposeError is set', async () => {
      const events: Events = []
      const failures: string[] = []
      const diOptions = { messageQueueConsumersEnabled: ['consumer'] }
      const FailingConsumer = class {
        start() {
          return Promise.resolve()
        }
        close() {
          return Promise.reject(new Error('channel already closed'))
        }
      }
      const context = createLifecycleContext(
        {
          consumer: asMessageQueueHandlerClass(FailingConsumer, {
            queueName: 'consumer',
            diOptions,
          }),
          connection: asFunction(() => ({}), {
            asyncDispose: () => {
              events.push('connection')
              return Promise.resolve()
            },
            asyncDisposePriority: 20,
          }),
        },
        {
          ...diOptions,
          onDisposeError: (dependencyName) => {
            failures.push(dependencyName)
          },
        },
      )
      await context.init()

      await context.destroy()

      expect(failures).toEqual(['consumer'])
      expect(events).toEqual(['connection'])
    })
  })
})
