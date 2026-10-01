import type { BuildResolver, BuildResolverOptions, Constructor, DisposableResolver } from 'awilix'
import { asClass, asFunction } from 'awilix'
import type { FunctionReturning } from 'awilix/lib/container'
import type { DependencyInjectionOptions } from './DIContext.js'
import {
  isEnqueuedJobWorkersEnabled,
  isJobQueueEnabled,
  isMessageQueueConsumerEnabled,
  isPeriodicJobEnabled,
  resolveJobQueuesEnabled,
} from './diConfigUtils.js'

/**
 * Type-level representation of a class value that infers the instance type
 * from the `prototype` property rather than from the constructor signature.
 *
 * This breaks circular type dependencies that occur when a class constructor
 * references a type derived from the module's own resolver return type
 * (e.g. `InferModuleDependencies`), because TypeScript can resolve the
 * instance type (prototype) without evaluating constructor parameter types.
 *
 * Constructor parameter types are still fully checked — the cycle is only
 * broken at the resolver inference level.
 */
type ClassValue<T> = { prototype: T }

declare module 'awilix' {
  interface ResolverOptions<T> {
    public?: boolean // if module is used as secondary, only public dependencies will be exposed. default is false
  }
}

export type PublicResolver<T> = BuildResolver<T> &
  DisposableResolver<T> & { readonly __publicResolver: true }

// this follows background-jobs-common conventions
export interface EnqueuedJobQueueManager {
  start(enabled?: string[] | boolean): Promise<void>
}

// this follows message-queue-toolkit conventions
export interface DisposableDomainEventEmitter {
  dispose(): Promise<void>
}

export function asSingletonClass<T = object>(
  Type: ClassValue<T>,
  opts: BuildResolverOptions<T> & { public: true },
): PublicResolver<T>
export function asSingletonClass<T = object>(
  Type: ClassValue<T>,
  opts?: BuildResolverOptions<T>,
): BuildResolver<T> & DisposableResolver<T>
export function asSingletonClass<T = object>(
  Type: ClassValue<T>,
  opts?: BuildResolverOptions<T>,
): BuildResolver<T> & DisposableResolver<T> {
  return asClass(Type as unknown as Constructor<T>, {
    ...opts,
    lifetime: 'SINGLETON',
  })
}

/**
 * Register a class with an additional config parameter passed to the constructor.
 * Uses asFunction wrapper internally to pass the config as a second parameter.
 * Requires PROXY injection mode.
 *
 * @example
 * ```typescript
 * myService: asClassWithConfig(MyService, { enableFeature: true }),
 * ```
 */
export function asClassWithConfig<T = object, Config = unknown>(
  Type: ClassValue<T>,
  config: Config,
  opts?: BuildResolverOptions<T>,
): BuildResolver<T> & DisposableResolver<T> {
  const Ctor = Type as unknown as Constructor<T>
  // biome-ignore lint/suspicious/noExplicitAny: Dynamic constructor invocation with cradle proxy
  return asFunction((cradle: any) => new Ctor(cradle, config), {
    ...opts,
    lifetime: opts?.lifetime ?? 'SINGLETON',
  })
}

export function asSingletonFunction<T>(
  fn: FunctionReturning<T>,
  opts: BuildResolverOptions<T> & { public: true },
): PublicResolver<T>
export function asSingletonFunction<T>(
  fn: FunctionReturning<T>,
  opts?: BuildResolverOptions<T>,
): BuildResolver<T> & DisposableResolver<T>
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
  Type: ClassValue<T>,
  opts: BuildResolverOptions<T> & { public: false },
): BuildResolver<T> & DisposableResolver<T>
export function asServiceClass<T = object>(
  Type: ClassValue<T>,
  opts?: BuildResolverOptions<T>,
): PublicResolver<T>
export function asServiceClass<T = object>(
  Type: ClassValue<T>,
  opts?: BuildResolverOptions<T>,
): BuildResolver<T> & DisposableResolver<T> {
  return asClass(Type as unknown as Constructor<T>, {
    public: true,
    ...opts,
    lifetime: 'SINGLETON',
  })
}

export function asUseCaseClass<T = object>(
  Type: ClassValue<T>,
  opts: BuildResolverOptions<T> & { public: false },
): BuildResolver<T> & DisposableResolver<T>
export function asUseCaseClass<T = object>(
  Type: ClassValue<T>,
  opts?: BuildResolverOptions<T>,
): PublicResolver<T>
export function asUseCaseClass<T = object>(
  Type: ClassValue<T>,
  opts?: BuildResolverOptions<T>,
): BuildResolver<T> & DisposableResolver<T> {
  return asClass(Type as unknown as Constructor<T>, {
    public: true,
    ...opts,
    lifetime: 'SINGLETON',
  })
}

export function asRepositoryClass<T = object>(
  Type: ClassValue<T>,
  opts?: BuildResolverOptions<T>,
): BuildResolver<T> & DisposableResolver<T> {
  return asClass(Type as unknown as Constructor<T>, {
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
  Type: ClassValue<T>,
  mqOptions: MessageQueueConsumerModuleOptions,
  opts?: BuildResolverOptions<T>,
): BuildResolver<T> & DisposableResolver<T> {
  return asClass(Type as unknown as Constructor<T>, {
    // these follow message-queue-toolkit conventions
    // consumers only set up their own queue and subscription, so they do not have to start one by one
    asyncInit: { method: 'start', concurrent: true },
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

export type EnqueuedJobWorkerModuleOptions = {
  queueName: string
  diOptions: DependencyInjectionOptions
}

export function asEnqueuedJobWorkerClass<T = object>(
  Type: ClassValue<T>,
  workerOptions: EnqueuedJobWorkerModuleOptions,
  opts?: BuildResolverOptions<T>,
): BuildResolver<T> & DisposableResolver<T> {
  return asClass(Type as unknown as Constructor<T>, {
    // these follow background-jobs-common conventions
    // workers only attach to their own queue, so they do not have to start one by one
    asyncInit: { method: 'start', concurrent: true },
    asyncDispose: 'dispose',
    asyncDisposePriority: 15,
    public: false,

    enabled: isEnqueuedJobWorkersEnabled(
      workerOptions.diOptions.enqueuedJobWorkersEnabled,
      workerOptions.queueName,
    ),
    lifetime: 'SINGLETON',
    ...opts,
  })
}

/**
 * Helper function to register a pg-boss job processor class with the DI container.
 * Handles asyncInit/asyncDispose lifecycle and enabled check based on diOptions.
 *
 * @example
 * ```typescript
 * enrichUserPresenceJob: asPgBossProcessorClass(EnrichUserPresenceJob, {
 *   diOptions,
 *   queueName: EnrichUserPresenceJob.QUEUE_ID,
 * }),
 * ```
 */
export function asPgBossProcessorClass<T extends { start(): Promise<void>; stop(): Promise<void> }>(
  Type: ClassValue<T>,
  processorOptions: EnqueuedJobWorkerModuleOptions,
  opts?: BuildResolverOptions<T>,
): BuildResolver<T> & DisposableResolver<T> {
  return asClass(Type as unknown as Constructor<T>, {
    asyncInit: 'start',
    asyncInitPriority: 20, // Initialize after pgBoss (priority 10)
    asyncDispose: 'stop',
    asyncDisposePriority: 10,
    public: false,

    enabled: isEnqueuedJobWorkersEnabled(
      processorOptions.diOptions.enqueuedJobWorkersEnabled,
      processorOptions.queueName,
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
  Type: ClassValue<T>,
  workerOptions: PeriodicJobOptions,
  opts?: BuildResolverOptions<T>,
): BuildResolver<T> & DisposableResolver<T> {
  return asClass(Type as unknown as Constructor<T>, {
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

export function asDomainEventEmitterFunction<T extends DisposableDomainEventEmitter>(
  fn: FunctionReturning<T>,
  opts: BuildResolverOptions<T> & { public: false },
): BuildResolver<T> & DisposableResolver<T>
export function asDomainEventEmitterFunction<T extends DisposableDomainEventEmitter>(
  fn: FunctionReturning<T>,
  opts?: BuildResolverOptions<T>,
): PublicResolver<T>
export function asDomainEventEmitterFunction<T extends DisposableDomainEventEmitter>(
  fn: FunctionReturning<T>,
  opts?: BuildResolverOptions<T>,
): BuildResolver<T> & DisposableResolver<T> {
  return asFunction(fn, {
    // this follows message-queue-toolkit conventions
    asyncDispose: 'dispose',
    // Disposing the emitter stops it accepting events, so it comes after everything that can still
    // emit - queue consumers (10) and job workers (15) - and before the queue manager (20) and the
    // clients closed by container.dispose(), which its draining handlers still need.
    asyncDisposePriority: 17,
    public: true,
    lifetime: 'SINGLETON',
    ...opts,
  })
}

export type JobQueueModuleOptions = {
  queueName?: string // if not specified, assume this is a manager that controls all queues
  diOptions: DependencyInjectionOptions
}

export function asJobQueueClass<T = object>(
  Type: ClassValue<T>,
  queueOptions: JobQueueModuleOptions,
  opts: BuildResolverOptions<T> & { public: false },
): BuildResolver<T> & DisposableResolver<T>
export function asJobQueueClass<T = object>(
  Type: ClassValue<T>,
  queueOptions: JobQueueModuleOptions,
  opts?: BuildResolverOptions<T>,
): PublicResolver<T>
export function asJobQueueClass<T = object>(
  Type: ClassValue<T>,
  queueOptions: JobQueueModuleOptions,
  opts?: BuildResolverOptions<T>,
): BuildResolver<T> & DisposableResolver<T> {
  return asClass(Type as unknown as Constructor<T>, {
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

export function asEnqueuedJobQueueManagerFunction<T extends EnqueuedJobQueueManager>(
  fn: FunctionReturning<T>,
  diOptions: DependencyInjectionOptions,
  opts: BuildResolverOptions<T> & { public: false },
): BuildResolver<T> & DisposableResolver<T>
export function asEnqueuedJobQueueManagerFunction<T extends EnqueuedJobQueueManager>(
  fn: FunctionReturning<T>,
  diOptions: DependencyInjectionOptions,
  opts?: BuildResolverOptions<T>,
): PublicResolver<T>
export function asEnqueuedJobQueueManagerFunction<T extends EnqueuedJobQueueManager>(
  fn: FunctionReturning<T>,
  diOptions: DependencyInjectionOptions,
  opts?: BuildResolverOptions<T>,
): BuildResolver<T> & DisposableResolver<T> {
  return asFunction(fn, {
    // these follow background-jobs-common conventions
    asyncInit: (manager) => manager.start(resolveJobQueuesEnabled(diOptions)),
    asyncDispose: 'dispose',
    asyncInitPriority: 20,
    asyncDisposePriority: 20,
    public: true,
    enabled: isJobQueueEnabled(diOptions.jobQueuesEnabled),
    lifetime: 'SINGLETON',
    ...opts,
  })
}
