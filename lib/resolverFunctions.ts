import { asClass, asFunction } from 'awilix'
import type { BuildResolver, BuildResolverOptions, Constructor, DisposableResolver } from 'awilix'
import type { FunctionReturning } from 'awilix/lib/container'
import type { DependencyInjectionOptions } from './DIContext.js'
import {
  isJobQueueEnabled,
  isJobWorkersEnabled,
  isMessageQueueConsumerEnabled,
  isPeriodicJobEnabled,
} from './diConfigUtils.js'

declare module 'awilix' {
  // biome-ignore lint/correctness/noUnusedVariables: expected by the signature
  interface ResolverOptions<T> {
    public?: boolean // if module is used as secondary, only public dependencies will be exposed. default is false
  }
}

export function asSingletonClass<T = object>(
  Type: Constructor<T>,
  opts?: BuildResolverOptions<T>,
): BuildResolver<T> & DisposableResolver<T> {
  return asClass(Type, {
    ...opts,
    lifetime: 'SINGLETON',
  })
}

export function asSingletonFunction<T>(
  fn: FunctionReturning<T>,
  opts?: BuildResolverOptions<T>,
): BuildResolver<T> & DisposableResolver<T> {
  return asFunction(fn, {
    ...opts,
    lifetime: 'SINGLETON',
  })
}

export function asServiceClass<T = object>(
  Type: Constructor<T>,
  opts?: BuildResolverOptions<T>,
): BuildResolver<T> & DisposableResolver<T> {
  return asClass(Type, {
    public: true,
    ...opts,
    lifetime: 'SINGLETON',
  })
}

export function asUseCaseClass<T = object>(
  Type: Constructor<T>,
  opts?: BuildResolverOptions<T>,
): BuildResolver<T> & DisposableResolver<T> {
  return asClass(Type, {
    public: true,
    ...opts,
    lifetime: 'SINGLETON',
  })
}

export function asRepositoryClass<T = object>(
  Type: Constructor<T>,
  opts?: BuildResolverOptions<T>,
): BuildResolver<T> & DisposableResolver<T> {
  return asClass(Type, {
    public: false,
    ...opts,
    lifetime: 'SINGLETON',
  })
}

export function asControllerClass<T = object>(
  Type: Constructor<T>,
  opts?: BuildResolverOptions<T>,
): BuildResolver<T> & DisposableResolver<T> {
  return asClass(Type, {
    public: false,
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
    public: false,
    ...opts,
  })
}

export type JobWorkerModuleOptions = {
  queueName: string
  diOptions: DependencyInjectionOptions
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
    asyncDisposePriority: 15,
    public: false,

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
    asyncDispose: 'dispose',
    public: false,

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
    public: true,

    enabled: isJobQueueEnabled(queueOptions.diOptions.jobQueuesEnabled, queueOptions.queueName),
    lifetime: 'SINGLETON',
    ...opts,
  })
}
