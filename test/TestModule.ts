import { asClass, asFunction, type InferCradleFromResolvers } from 'awilix'
import {
  AbstractModule,
  type AvailableDependencies,
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
} from '../lib/resolverFunctions.js'
import { TestController } from './TestController.js'
import type {
  TestModuleSecondaryPublicDependencies,
  TestServiceSecondary,
} from './TestModuleSecondary.js'

export class TestService {
  public counter = 0
  private readonly _testFunction: () => void
  private readonly _testServiceSecondary: TestServiceSecondary

  constructor({
    testFunction,
    testServiceSecondary,
  }: AvailableDependencies<TestModuleSecondaryPublicDependencies>) {
    this._testFunction = testFunction
    this._testServiceSecondary = testServiceSecondary
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
    const deps = {
      testService: asServiceClass(TestService),
      testServiceWithTransitive: asServiceClass(TestServiceWithTransitive),
      testServiceFromFunction: asFunction(
        ({
          testFunction,
          testServiceSecondary,
        }: AvailableDependencies<TestModuleSecondaryPublicDependencies>) => {
          return new TestService({
            testServiceSecondary,
            testFunction,
          })
        },
      ),
    }

    return {
      ...deps,
      testFunction: asFunction(({ testService }: InferCradleFromResolvers<typeof deps>) => {
        return () => {
          testService.execute()
        }
      }),

      testExpendable: asClass(TestService),

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
