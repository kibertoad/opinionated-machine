import { asClass } from 'awilix'
import type { BuildResolver, BuildResolverOptions, Constructor, DisposableResolver } from 'awilix'
import {
  type ENABLE_ALL,
  isJobQueueEnabled,
  isJobWorkersEnabled,
  isMessageQueueConsumerEnabled,
} from './diConfigUtils.js'

export function asSingletonClass<T = object>(
  Type: Constructor<T>,
  opts?: BuildResolverOptions<T>,
): BuildResolver<T> & DisposableResolver<T> {
  return asClass(Type, {
    ...opts,
    lifetime: 'SINGLETON',
  })
}

export function asControllerClass<T = object>(
  Type: Constructor<T>,
  opts?: BuildResolverOptions<T>,
): BuildResolver<T> & DisposableResolver<T> {
  return asClass(Type, {
    ...opts,
    lifetime: 'SINGLETON',
  })
}

export type MessageQueueConsumerModuleOptions = {
  queueName: string //
  messageQueueConsumersEnabled?: false | typeof ENABLE_ALL | string[]
}

export function asMessageQueueHandlerClass<T = object>(
  Type: Constructor<T>,
  mqOptions: MessageQueueConsumerModuleOptions,
  opts?: BuildResolverOptions<T>,
): BuildResolver<T> & DisposableResolver<T> {
  return asClass(Type, {
    // these follow message-queue-toolkit conventions
    asyncInit: 'start',
    asyncDispose: 'close',
    asyncDisposePriority: 10,

    enabled: isMessageQueueConsumerEnabled(
      mqOptions.messageQueueConsumersEnabled,
      mqOptions.queueName,
    ),
    lifetime: 'SINGLETON',
    ...opts,
  })
}

export type JobWorkerModuleOptions = {
  queueName: string //
  jobWorkersEnabled?: false | typeof ENABLE_ALL | string[]
}

export function asJobWorkerClass<T = object>(
  Type: Constructor<T>,
  workerOptions: JobWorkerModuleOptions,
  opts?: BuildResolverOptions<T>,
): BuildResolver<T> & DisposableResolver<T> {
  return asClass(Type, {
    // these follow background-jobs-common conventions
    asyncInit: 'start',
    asyncDispose: 'dispose',
    asyncDisposePriority: 10,

    enabled: isJobWorkersEnabled(workerOptions.jobWorkersEnabled, workerOptions.queueName),
    lifetime: 'SINGLETON',
    ...opts,
  })
}

export type JobQueueModuleOptions = {
  queueName?: string // if not specified, assume this is a manager that controls all queues
  jobQueuesEnabled?: false | typeof ENABLE_ALL | string[]
}

export function asJobQueueClass<T = object>(
  Type: Constructor<T>,
  queueOptions: JobQueueModuleOptions,
  opts?: BuildResolverOptions<T>,
): BuildResolver<T> & DisposableResolver<T> {
  return asClass(Type, {
    // these follow background-jobs-common conventions
    asyncInit: 'start',
    asyncDispose: 'dispose',
    asyncDisposePriority: 20,

    enabled: isJobQueueEnabled(queueOptions.jobQueuesEnabled, queueOptions.queueName),
    lifetime: 'SINGLETON',
    ...opts,
  })
}
