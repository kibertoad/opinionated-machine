import { asClass } from 'awilix'
import { AbstractModule, type MandatoryNameAndRegistrationPair } from '../lib/AbstractModule.js'
import type { DependencyInjectionOptions } from '../lib/DIContext.js'
import { resolveJobQueuesEnabled } from '../lib/diConfigUtils.js'
import {
  asControllerClass,
  asJobQueueClass,
  asJobWorkerClass,
  asMessageQueueHandlerClass,
  asSingletonClass,
} from '../lib/resolverFunctions.js'
import { TestController } from './TestController.js'

export class TestService {
  public counter = 0
}

export class TestService2 extends TestService {}

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

export type TestModuleDependencies = {
  testService: TestService
  testExpendable: TestService
  messageQueueConsumer: TestMessageQueueConsumer
  jobWorker: JobWorker
  queueManager: QueueManager
}

export class TestModule extends AbstractModule<TestModuleDependencies> {
  resolveDIConfig(
    options: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<TestModuleDependencies> {
    return {
      testService: asSingletonClass(TestService),

      testExpendable: asClass(TestService),

      messageQueueConsumer: asMessageQueueHandlerClass(TestMessageQueueConsumer, {
        queueName: TestMessageQueueConsumer.QUEUE_ID,
        messageQueueConsumersEnabled: options.messageQueueConsumersEnabled,
      }),

      jobWorker: asJobWorkerClass(JobWorker, {
        queueName: JobWorker.QUEUE_ID,
        jobWorkersEnabled: options.jobWorkersEnabled,
      }),

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

  resolveControllers(): MandatoryNameAndRegistrationPair<any> {
    return {
      testController: asControllerClass(TestController),
    }
  }
}
