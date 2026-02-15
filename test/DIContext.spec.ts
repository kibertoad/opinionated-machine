import { injectDelete } from '@lokalise/fastify-api-contracts'
import { asClass, createContainer, type NameAndRegistrationPair } from 'awilix'
import { fastify } from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { describe, expect, it } from 'vitest'
import type { AbstractModule, UnionToIntersection } from '../lib/AbstractModule.js'
import { type DependencyInjectionOptions, DIContext } from '../lib/DIContext.js'
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

      const response = await injectDelete(app, TestController.contracts.deleteItem, {
        pathParams: {
          userId: '1',
        },
      })

      expect(response.statusCode).toBe(200)
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
      const context = createContext<
        UnionToIntersection<TestModuleDependencies | TestModuleSecondaryPublicDependencies>
      >({}, {}, [new TestModuleSecondary()])

      const { testServiceSecondary } = context.diContainer.cradle

      await testServiceSecondary.execute()
    })

    it('does not resolve private dependency from a secondary module', () => {
      const context = createContext<
        UnionToIntersection<TestModuleDependencies | TestModuleSecondaryDependencies>
      >({}, {}, [new TestModuleSecondary()])

      expect(() => context.diContainer.cradle.testRepository).toThrowError(/Could not resolve/)
    })

    it('resolves transitive dependencies from a secondary module', async () => {
      const context = createContext<
        UnionToIntersection<TestModuleDependencies | TestModuleSecondaryPublicDependencies>
      >({}, {}, [new TestModuleSecondary()])

      const { testServiceWithTransitive } = context.diContainer.cradle

      await testServiceWithTransitive.execute()
    })
  })
})
