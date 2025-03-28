import { asClass } from 'awilix'
import type { BuildResolver, BuildResolverOptions, Constructor, DisposableResolver } from 'awilix'
import type { DependencyInjectionOptions } from './DIContext.js'
import {
  isJobQueueEnabled,
  isJobWorkersEnabled,
  isMessageQueueConsumerEnabled,
  isPeriodicJobEnabled,
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

// Do we need a as singleton function? (name tbd)

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
  queueName: string // can be queue or topic depending on the context
  diOptions: DependencyInjectionOptions
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
      mqOptions.diOptions.messageQueueConsumersEnabled,
      mqOptions.queueName,
    ),
    lifetime: 'SINGLETON',
    ...opts,
  })
}

export type JobWorkerModuleOptions = {
  queueName: string // Nit: I think this is called queueId
  diOptions: DependencyInjectionOptions
}

export function asJobWorkerClass<T = object>( // nit: I think we call them processors
  Type: Constructor<T>,
  workerOptions: JobWorkerModuleOptions,
  opts?: BuildResolverOptions<T>,
): BuildResolver<T> & DisposableResolver<T> {
  return asClass(Type, {
    // these follow background-jobs-common conventions
    asyncInit: 'start',
    asyncDispose: 'dispose',
    asyncDisposePriority: 10, // I think we are using 15, not sure the reason but mentioning just in case

    enabled: isJobWorkersEnabled(
      workerOptions.diOptions.jobWorkersEnabled,
      workerOptions.queueName,
    ),
    lifetime: 'SINGLETON',
    ...opts,
  })
}

export type PeriodicJobOptions = {
  jobName: string
  diOptions: DependencyInjectionOptions
}

export function asPeriodicJobClass<T = object>(
  Type: Constructor<T>,
  workerOptions: PeriodicJobOptions,
  opts?: BuildResolverOptions<T>,
): BuildResolver<T> & DisposableResolver<T> {
  return asClass(Type, {
    // this follows background-jobs-common conventions
    eagerInject: 'register',

    enabled: isPeriodicJobEnabled(
      workerOptions.diOptions.periodicJobsEnabled,
      workerOptions.jobName,
    ),
    lifetime: 'SINGLETON',
    ...opts,
  })
}

export type JobQueueModuleOptions = {
  queueName?: string // if not specified, assume this is a manager that controls all queues
  diOptions: DependencyInjectionOptions
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

    enabled: isJobQueueEnabled(queueOptions.diOptions.jobQueuesEnabled, queueOptions.queueName),
    lifetime: 'SINGLETON',
    ...opts,
  })
}
