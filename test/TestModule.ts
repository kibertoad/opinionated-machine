import { asClass } from 'awilix'
import {
  AbstractModule,
  type InferModuleDependencies,
  type MandatoryNameAndRegistrationPair,
} from '../lib/AbstractModule.js'
import type { DependencyInjectionOptions } from '../lib/DIContext.js'
import {
  asControllerClass,
  asEnqueuedJobQueueManagerFunction,
  asEnqueuedJobWorkerClass,
  asJobQueueClass,
  asMessageQueueHandlerClass,
  asPeriodicJobClass,
  asServiceClass,
  asSingletonClass,
  asSingletonFunction,
} from '../lib/resolverFunctions.js'
import { TestController } from './TestController.js'
import type {
  TestModuleSecondaryPublicDependencies,
  TestServiceSecondary,
} from './TestModuleSecondary.js'

export class TestHelper {
  process() {}
}

// Simulates a third-party class with non-DI-compatible constructor
export class ThirdPartyClient {
  // biome-ignore lint/complexity/noUselessConstructor: for testing
  constructor(_opts: { region: string }) {}
  doWork(): string {
    return 'done'
  }
}

export class Config {
  readonly region: string = 'us-east-1'
}

export class ExpendableTestService {
  public counter = 0
  execute() {}
}

export class TestService {
  public counter = 0
  private readonly _testFunction: () => void
  private readonly _testHelper: TestHelper

  constructor({ testFunction, testHelper }: TestModuleDependencies) {
    this._testFunction = testFunction
    this._testHelper = testHelper
  }

  execute() {}
}

export class TestService2 extends TestService {}

export class TestServiceWithTransitive {
  private service: TestServiceSecondary
  constructor({ testServiceSecondary }: TestModuleSecondaryPublicDependencies) {
    this.service = testServiceSecondary
  }

  execute(): Promise<void> {
    return this.service.execute()
  }
}

export class TestMessageQueueConsumer {
  public static readonly QUEUE_ID = 'queue'
  isStarted = false

  start() {
    this.isStarted = true
    return Promise.resolve()
  }

  close() {
    this.isStarted = false
    return Promise.resolve()
  }
}

export class Queue {}

export class QueueManager {
  startedQueues: string[] = []

  start(queues: boolean | string[]) {
    this.startedQueues = Array.isArray(queues)
      ? [...queues]
      : queues === true
        ? [JobWorker.QUEUE_ID]
        : []
    return Promise.resolve()
  }

  dispose() {
    this.startedQueues = []
    return Promise.resolve()
  }
}

export class JobWorker {
  public static readonly QUEUE_ID = 'job-queue'
  isStarted = false

  start() {
    this.isStarted = true
    return Promise.resolve()
  }

  dispose() {
    this.isStarted = false
    return Promise.resolve()
  }
}

export class PeriodicJob {
  public static readonly JOB_NAME = 'periodic_job'
  isStarted = false

  register() {
    this.isStarted = true
    return Promise.resolve()
  }

  dispose() {
    this.isStarted = false
    return Promise.resolve()
  }
}

export class TestModule extends AbstractModule {
  resolveDependencies(diOptions: DependencyInjectionOptions) {
    return {
      config: asSingletonClass(Config),
      testHelper: asSingletonClass(TestHelper),
      testService: asServiceClass(TestService),
      testServiceWithTransitive: asServiceClass(TestServiceWithTransitive),

      // asSingletonFunction: indexed access + explicit return type
      testServiceFromFunction: asSingletonFunction(
        ({ testHelper }: { testHelper: TestModuleDependencies['testHelper'] }): TestService => {
          return new TestService({ testFunction: () => {}, testHelper } as TestModuleDependencies)
        },
      ),

      testFunction: asSingletonFunction(
        ({ testHelper }: { testHelper: TestModuleDependencies['testHelper'] }): (() => void) => {
          return () => {
            testHelper.process()
          }
        },
      ),

      // Wrapping a third-party class with non-DI-compatible constructor
      thirdPartyClient: asSingletonFunction(
        ({ config }: { config: TestModuleDependencies['config'] }): ThirdPartyClient => {
          return new ThirdPartyClient({ region: config.region })
        },
      ),

      testExpendable: asClass(ExpendableTestService),

      messageQueueConsumer: asMessageQueueHandlerClass(TestMessageQueueConsumer, {
        queueName: TestMessageQueueConsumer.QUEUE_ID,
        diOptions,
      }),

      jobWorker: asEnqueuedJobWorkerClass(JobWorker, {
        queueName: JobWorker.QUEUE_ID,
        diOptions,
      }),

      periodicJob: asPeriodicJobClass(PeriodicJob, {
        jobName: PeriodicJob.JOB_NAME,
        diOptions,
      }),

      queue: asJobQueueClass(Queue, {
        diOptions,
        queueName: 'dummy',
      }),

      queueManager: asEnqueuedJobQueueManagerFunction(() => new QueueManager(), diOptions),
    }
  }

  override resolveControllers(
    _diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<unknown> {
    return {
      testController: asControllerClass(TestController),
    }
  }
}

export type TestModuleDependencies = InferModuleDependencies<TestModule>
