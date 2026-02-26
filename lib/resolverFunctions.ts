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
    isSSEController?: boolean // marks resolver as an SSE controller for special handling
    isDualModeController?: boolean // marks resolver as a dual-mode controller for special handling
  }
}

export type PublicResolver<T> = BuildResolver<T> &
  DisposableResolver<T> & { readonly __publicResolver: true }

// this follows background-jobs-common conventions
export interface EnqueuedJobQueueManager {
  start(enabled?: string[] | boolean): Promise<void>
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

export function asControllerClass<T = object>(
  Type: ClassValue<T>,
  opts?: BuildResolverOptions<T>,
): BuildResolver<T> & DisposableResolver<T> {
  return asClass(Type as unknown as Constructor<T>, {
    public: false,
    ...opts,
    lifetime: 'SINGLETON',
  })
}

export type SSEControllerModuleOptions = {
  diOptions: DependencyInjectionOptions
}

/**
 * Register an SSE controller class with the DI container.
 *
 * SSE controllers handle Server-Sent Events connections and require
 * graceful shutdown to close all active connections.
 *
 * When `diOptions.isTestMode` is true, connection spying is enabled
 * allowing tests to await connections via `controller.connectionSpy`.
 *
 * @example
 * ```typescript
 * // Without test mode
 * notificationsSSEController: asSSEControllerClass(NotificationsSSEController),
 *
 * // With test mode (enables connection spy)
 * notificationsSSEController: asSSEControllerClass(NotificationsSSEController, { diOptions }),
 * ```
 */
export function asSSEControllerClass<T = object>(
  Type: ClassValue<T>,
  sseOptions?: SSEControllerModuleOptions,
  opts?: BuildResolverOptions<T>,
): BuildResolver<T> & DisposableResolver<T> {
  const enableConnectionSpy = sseOptions?.diOptions.isTestMode ?? false
  const sseConfig = enableConnectionSpy ? { enableConnectionSpy: true } : undefined

  return asClassWithConfig(Type, sseConfig, {
    public: false,
    isSSEController: true,
    asyncDispose: 'closeAllConnections',
    asyncDisposePriority: 5, // Close SSE connections early in shutdown
    ...opts,
    lifetime: 'SINGLETON',
  })
}

export type DualModeControllerModuleOptions = {
  diOptions: DependencyInjectionOptions
}

/**
 * Register a dual-mode controller class with the DI container.
 *
 * Dual-mode controllers handle both SSE streaming and JSON responses on the
 * same route path, automatically branching based on the `Accept` header.
 * They require graceful shutdown to close all active SSE connections.
 *
 * When `diOptions.isTestMode` is true, connection spying is enabled
 * allowing tests to await connections via `controller.connectionSpy`.
 *
 * @example
 * ```typescript
 * // Without test mode
 * chatController: asDualModeControllerClass(ChatController),
 *
 * // With test mode (enables connection spy)
 * chatController: asDualModeControllerClass(ChatController, { diOptions }),
 * ```
 */
export function asDualModeControllerClass<T = object>(
  Type: ClassValue<T>,
  dualModeOptions?: DualModeControllerModuleOptions,
  opts?: BuildResolverOptions<T>,
): BuildResolver<T> & DisposableResolver<T> {
  const enableConnectionSpy = dualModeOptions?.diOptions.isTestMode ?? false
  const config = enableConnectionSpy ? { enableConnectionSpy: true } : undefined

  return asClassWithConfig(Type, config, {
    public: false,
    isDualModeController: true,
    asyncDispose: 'closeAllConnections',
    asyncDisposePriority: 5, // Close connections early in shutdown
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
    asyncInit: 'start',
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
