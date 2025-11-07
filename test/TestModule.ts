import { asClass } from 'awilix'
import { AbstractModule, type MandatoryNameAndRegistrationPair } from '../lib/AbstractModule.ts'
import type { DependencyInjectionOptions } from '../lib/DIContext.ts'
import {
  asControllerClass,
  asEnqueuedJobQueueManagerFunction,
  asEnqueuedJobWorkerClass,
  asJobQueueClass,
  asMessageQueueHandlerClass,
  asPeriodicJobClass,
  asServiceClass,
} from '../lib/resolverFunctions.ts'
import { TestController } from './TestController.ts'
import type {
  TestModuleSecondaryPublicDependencies,
  TestServiceSecondary,
} from './TestModuleSecondary.ts'

export class TestService {
  public counter = 0

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

export type TestModuleDependencies = {
  testService: TestService
  testServiceWithTransitive: TestServiceWithTransitive
  testExpendable: TestService
  messageQueueConsumer: TestMessageQueueConsumer
  jobWorker: JobWorker
  queueManager: QueueManager
  queue: Queue
  periodicJob: PeriodicJob
}

export class TestModule extends AbstractModule<TestModuleDependencies> {
  resolveDependencies(
    diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<TestModuleDependencies> {
    return {
      testService: asServiceClass(TestService),
      testServiceWithTransitive: asServiceClass(TestServiceWithTransitive),

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

  resolveControllers(): MandatoryNameAndRegistrationPair<unknown> {
    return {
      testController: asControllerClass(TestController),
    }
  }
}
