export { AbstractController, type BuildRoutesReturnType } from './lib/AbstractController.js'
export {
  AbstractModule,
  type InferModuleDependencies,
  type InferPublicModuleDependencies,
  type MandatoryNameAndRegistrationPair,
  type PublicDependencies,
} from './lib/AbstractModule.js'
export {
  AbstractTestContextFactory,
  type CreateTestContextParams,
} from './lib/AbstractTestContextFactory.js'
export type { NestedPartial } from './lib/configUtils.js'
export {
  type DependencyInjectionOptions,
  DIContext,
  type RegisterDependenciesParams,
} from './lib/DIContext.js'
export {
  ENABLE_ALL,
  isAnyMessageQueueConsumerEnabled,
  isEnqueuedJobWorkersEnabled,
  isJobQueueEnabled,
  isMessageQueueConsumerEnabled,
  isPeriodicJobEnabled,
  resolveJobQueuesEnabled,
} from './lib/diConfigUtils.js'
// Dual-mode (SSE + JSON)
export * from './lib/dualmode/index.js'
export * from './lib/resolverFunctions.js'
// Routes (unified route builder)
export * from './lib/routes/index.js'
// SSE
export * from './lib/sse/index.js'
// SSE testing utilities
export * from './lib/testing/index.js'
