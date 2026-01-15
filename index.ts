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
  type InferSSERequest,
  type SSEConnection,
  type SSEConnectionEvent,
  SSEConnectionSpy,
  type SSEControllerConfig,
  type SSEHandlerConfig,
  type SSELogger,
  type SSEMessage,
  type SSEPreHandler,
  type SSERouteHandler,
  type SSERouteOptions,
} from './lib/sse/AbstractSSEController.js'
export {
  type AnySSERouteDefinition,
  buildPayloadSSERoute,
  buildSSEHandler,
  buildSSERoute,
  type PayloadSSERouteConfig,
  type SSEMethod,
  type SSERouteConfig,
  type SSERouteDefinition,
} from './lib/sse/sseContracts.js'
// SSE parsing utilities (production)
export {
  type ParsedSSEEvent,
  type ParseSSEBufferResult,
  parseSSEBuffer,
  parseSSEEvents,
} from './lib/sse/sseParser.js'
export {
  buildFastifySSERoute,
  type RegisterSSERoutesOptions,
} from './lib/sse/sseRouteBuilder.js'
// SSE testing utilities
export {
  type HasConnectionSpy,
  SSEHttpClient,
  type SSEHttpConnectOptions,
  type SSEHttpConnectResult,
  type SSEHttpConnectWithSpyOptions,
} from './lib/testing/sseHttpClient.js'
export { SSEInjectClient, SSEInjectConnection } from './lib/testing/sseInjectClient.js'
export { buildUrl, injectPayloadSSE, injectSSE } from './lib/testing/sseInjectHelpers.js'
export { SSETestServer } from './lib/testing/sseTestServer.js'
export type {
  CreateSSETestServerOptions,
  InjectPayloadSSEOptions,
  InjectSSEOptions,
  InjectSSEResult,
  SSEConnectOptions,
  SSEResponse,
  SSETestConnection,
} from './lib/testing/sseTestTypes.js'
