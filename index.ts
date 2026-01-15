export { AbstractController, type BuildRoutesReturnType } from './lib/AbstractController.js'
export {
  AbstractModule,
  type MandatoryNameAndRegistrationPair,
  type UnionToIntersection,
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
export type {
  EnqueuedJobWorkerModuleOptions,
  JobQueueModuleOptions,
  MessageQueueConsumerModuleOptions,
  PeriodicJobOptions,
} from './lib/resolverFunctions.js'
export {
  asClassWithConfig,
  asControllerClass,
  asEnqueuedJobQueueManagerFunction,
  asEnqueuedJobWorkerClass,
  asJobQueueClass,
  asMessageQueueHandlerClass,
  asPeriodicJobClass,
  asPgBossProcessorClass,
  asRepositoryClass,
  asServiceClass,
  asSingletonClass,
  asSingletonFunction,
  asSSEControllerClass,
  asUseCaseClass,
  type EnqueuedJobQueueManager,
  type SSEControllerModuleOptions,
} from './lib/resolverFunctions.js'
export {
  AbstractSSEController,
  type BuildSSERoutesReturnType,
  type SSEConnection,
  type SSEConnectionEvent,
  SSEConnectionSpy,
  type SSEControllerConfig,
  type SSEHandlerConfig,
  type SSEMessage,
  type SSEPreHandler,
  type SSERouteHandler,
  type SSERouteOptions,
} from './lib/sse/AbstractSSEController.ts'
export {
  type AnySSERouteDefinition,
  buildPayloadSSERoute,
  buildSSERoute,
  type PayloadSSERouteConfig,
  type SSEMethod,
  type SSERouteConfig,
  type SSERouteDefinition,
} from './lib/sse/sseContracts.ts'
// SSE parsing utilities (production)
export {
  type ParsedSSEEvent,
  type ParseSSEBufferResult,
  parseSSEBuffer,
  parseSSEEvents,
} from './lib/sse/sseParser.ts'
export {
  buildFastifySSERoute,
  type RegisterSSERoutesOptions,
} from './lib/sse/sseRouteBuilder.ts'
// SSE testing utilities
export {
  type CreateSSETestServerOptions,
  type InjectPayloadSSEOptions,
  type InjectSSEOptions,
  type InjectSSEResult,
  injectPayloadSSE,
  injectSSE,
  type SSEConnectOptions,
  SSEHttpClient,
  SSEInjectClient,
  type SSEResponse,
  type SSETestConnection,
  SSETestServer,
} from './lib/testing/sseTestUtils.js'
