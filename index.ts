export {
  DIContext,
  type DependencyInjectionOptions,
  type RegisterDependenciesParams,
} from './lib/DIContext.js'
export {
  AbstractModule,
  type MandatoryNameAndRegistrationPair,
  type UnionToIntersection,
} from './lib/AbstractModule.js'
export {
  ENABLE_ALL,
  resolveJobQueuesEnabled,
  isAnyMessageQueueConsumerEnabled,
  isJobQueueEnabled,
  isMessageQueueConsumerEnabled,
  isEnqueuedJobWorkersEnabled,
  isPeriodicJobEnabled,
} from './lib/diConfigUtils.js'
export { AbstractController } from './lib/AbstractController.js'
export {
  asJobQueueClass,
  asEnqueuedJobWorkerClass,
  asMessageQueueHandlerClass,
  asControllerClass,
  asSingletonClass,
  asPeriodicJobClass,
  asSingletonFunction,
  asServiceClass,
  asRepositoryClass,
  asUseCaseClass,
} from './lib/resolverFunctions.js'

export type {
  PeriodicJobOptions,
  JobQueueModuleOptions,
  MessageQueueConsumerModuleOptions,
  EnqueuedJobWorkerModuleOptions,
} from './lib/resolverFunctions.js'

export {
  AbstractTestContextFactory,
  type CreateTestContextParams,
} from './lib/AbstractTestContextFactory.js'

export type { NestedPartial } from './lib/configUtils.ts'
