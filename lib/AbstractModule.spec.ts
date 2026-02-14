import type { BuildResolver, DisposableResolver } from 'awilix'
import { describe, expectTypeOf, it } from 'vitest'
import {
  type JobWorker,
  type PeriodicJob,
  Queue,
  QueueManager,
  type TestMessageQueueConsumer,
  type TestModule,
  TestService,
  type TestServiceWithTransitive,
} from '../test/TestModule.ts'
import {
  type TestModuleSecondary,
  TestRepository,
  type TestServiceSecondary,
} from '../test/TestModuleSecondary.ts'
import type { InferModuleDependencies, InferPublicModuleDependencies } from './AbstractModule.ts'
import type { PublicResolver } from './resolverFunctions.ts'
import {
  asEnqueuedJobQueueManagerFunction,
  asJobQueueClass,
  asRepositoryClass,
  asServiceClass,
  asSingletonClass,
  asSingletonFunction,
  asUseCaseClass,
} from './resolverFunctions.ts'

describe('InferModuleDependencies', () => {
  it('infers all dependency types from a module', () => {
    type Deps = InferModuleDependencies<TestModule>

    expectTypeOf<Deps>().toHaveProperty('testService')
    expectTypeOf<Deps['testService']>().toEqualTypeOf<TestService>()

    expectTypeOf<Deps>().toHaveProperty('testServiceWithTransitive')
    expectTypeOf<Deps['testServiceWithTransitive']>().toEqualTypeOf<TestServiceWithTransitive>()

    expectTypeOf<Deps>().toHaveProperty('messageQueueConsumer')
    expectTypeOf<Deps['messageQueueConsumer']>().toEqualTypeOf<TestMessageQueueConsumer>()

    expectTypeOf<Deps>().toHaveProperty('jobWorker')
    expectTypeOf<Deps['jobWorker']>().toEqualTypeOf<JobWorker>()

    expectTypeOf<Deps>().toHaveProperty('periodicJob')
    expectTypeOf<Deps['periodicJob']>().toEqualTypeOf<PeriodicJob>()

    expectTypeOf<Deps>().toHaveProperty('queue')
    expectTypeOf<Deps['queue']>().toEqualTypeOf<Queue>()

    expectTypeOf<Deps>().toHaveProperty('queueManager')
    expectTypeOf<Deps['queueManager']>().toEqualTypeOf<QueueManager>()
  })

  it('infers all dependencies from secondary module', () => {
    type Deps = InferModuleDependencies<TestModuleSecondary>

    expectTypeOf<Deps>().toHaveProperty('testServiceSecondary')
    expectTypeOf<Deps['testServiceSecondary']>().toEqualTypeOf<TestServiceSecondary>()

    expectTypeOf<Deps>().toHaveProperty('testRepository')
    expectTypeOf<Deps['testRepository']>().toEqualTypeOf<TestRepository>()
  })
})

describe('InferPublicModuleDependencies', () => {
  it('infers only public dependencies from a module', () => {
    type PublicDeps = InferPublicModuleDependencies<TestModule>

    // Public: asServiceClass
    expectTypeOf<PublicDeps>().toHaveProperty('testService')
    expectTypeOf<PublicDeps['testService']>().toEqualTypeOf<TestService>()

    expectTypeOf<PublicDeps>().toHaveProperty('testServiceWithTransitive')
    expectTypeOf<
      PublicDeps['testServiceWithTransitive']
    >().toEqualTypeOf<TestServiceWithTransitive>()

    // Public: asJobQueueClass
    expectTypeOf<PublicDeps>().toHaveProperty('queue')
    expectTypeOf<PublicDeps['queue']>().toEqualTypeOf<Queue>()

    // Public: asEnqueuedJobQueueManagerFunction
    expectTypeOf<PublicDeps>().toHaveProperty('queueManager')
    expectTypeOf<PublicDeps['queueManager']>().toEqualTypeOf<QueueManager>()
  })

  it('excludes private dependencies', () => {
    type PublicDeps = InferPublicModuleDependencies<TestModule>

    // Private: raw asClass (no public flag)
    expectTypeOf<PublicDeps>().not.toHaveProperty('testExpendable')

    // Private: asMessageQueueHandlerClass
    expectTypeOf<PublicDeps>().not.toHaveProperty('messageQueueConsumer')

    // Private: asEnqueuedJobWorkerClass
    expectTypeOf<PublicDeps>().not.toHaveProperty('jobWorker')

    // Private: asPeriodicJobClass
    expectTypeOf<PublicDeps>().not.toHaveProperty('periodicJob')
  })

  it('infers only public dependencies from secondary module', () => {
    type PublicDeps = InferPublicModuleDependencies<TestModuleSecondary>

    // Public: asServiceClass
    expectTypeOf<PublicDeps>().toHaveProperty('testServiceSecondary')
    expectTypeOf<PublicDeps['testServiceSecondary']>().toEqualTypeOf<TestServiceSecondary>()
  })

  it('excludes private dependencies from secondary module', () => {
    type PublicDeps = InferPublicModuleDependencies<TestModuleSecondary>

    // Private: asRepositoryClass
    expectTypeOf<PublicDeps>().not.toHaveProperty('testRepository')
  })

  it('produces the same type as the manual Pick approach', () => {
    type ManualPick = Pick<InferModuleDependencies<TestModuleSecondary>, 'testServiceSecondary'>
    type Inferred = InferPublicModuleDependencies<TestModuleSecondary>

    expectTypeOf<Inferred>().toEqualTypeOf<ManualPick>()
  })
})

describe('PublicResolver branding', () => {
  it('returns PublicResolver by default for public resolver functions', () => {
    const service = asServiceClass(TestService)
    expectTypeOf(service).toExtend<PublicResolver<TestService>>()

    const useCase = asUseCaseClass(TestService)
    expectTypeOf(useCase).toExtend<PublicResolver<TestService>>()

    const jobQueue = asJobQueueClass(Queue, { diOptions: {} })
    expectTypeOf(jobQueue).toExtend<PublicResolver<Queue>>()

    const queueManager = asEnqueuedJobQueueManagerFunction(() => new QueueManager(), {})
    expectTypeOf(queueManager).toExtend<PublicResolver<QueueManager>>()
  })

  it('drops PublicResolver brand when public: false is passed', () => {
    const service = asServiceClass(TestService, { public: false })
    expectTypeOf(service).toExtend<BuildResolver<TestService> & DisposableResolver<TestService>>()
    expectTypeOf(service).not.toExtend<PublicResolver<TestService>>()

    const useCase = asUseCaseClass(TestService, { public: false })
    expectTypeOf(useCase).not.toExtend<PublicResolver<TestService>>()

    const jobQueue = asJobQueueClass(Queue, { diOptions: {} }, { public: false })
    expectTypeOf(jobQueue).not.toExtend<PublicResolver<Queue>>()

    const queueManager = asEnqueuedJobQueueManagerFunction(
      () => new QueueManager(),
      {},
      { public: false },
    )
    expectTypeOf(queueManager).not.toExtend<PublicResolver<QueueManager>>()
  })

  it('does not brand private resolver functions by default', () => {
    const repo = asRepositoryClass(TestRepository)
    expectTypeOf(repo).not.toExtend<PublicResolver<TestRepository>>()

    const singleton = asSingletonClass(TestService)
    expectTypeOf(singleton).not.toExtend<PublicResolver<TestService>>()

    const singletonFn = asSingletonFunction(() => new TestService())
    expectTypeOf(singletonFn).not.toExtend<PublicResolver<TestService>>()
  })

  it('brands asSingletonClass and asSingletonFunction when public: true is passed', () => {
    const singleton = asSingletonClass(TestService, { public: true })
    expectTypeOf(singleton).toExtend<PublicResolver<TestService>>()

    const singletonFn = asSingletonFunction(() => new TestService(), { public: true })
    expectTypeOf(singletonFn).toExtend<PublicResolver<TestService>>()
  })
})
