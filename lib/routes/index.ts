// Unified route builder
export { buildFastifyRoute, extractPathTemplate } from './fastifyRouteBuilder.js'

// Route types
export {
  type BuildFastifyDualModeRoutesReturnType,
  type BuildFastifySSERoutesReturnType,
  // Unified handler builder
  buildHandler,
  type DualModeHandlers,
  // Handler container types (new pattern)
  type DualModeRouteHandler,
  type FastifyDualModeHandlerConfig,
  type FastifyDualModeRouteOptions,
  type FastifySSEHandlerConfig,
  type FastifySSEPreHandler,
  type FastifySSERouteOptions,
  type InferDualModeHandlers,
  type InferHandlers,
  type InferSSERequest,
  type RegisterDualModeRoutesOptions,
  // Registration options
  type RegisterSSERoutesOptions,
  // SSE types
  type SSEContext,
  // SSE handler result types
  type SSEHandlerResult,
  type SSEModeHandler,
  type SSEOnlyHandlers,
  type SSERespondResult,
  // Handler container type (new pattern)
  type SSERouteHandler,
  type SSESession,
  type SSESessionMode,
  type SSEStartOptions,
  // SSE stream message type
  type SSEStreamMessage,
  // Sync mode handler type
  type SyncModeHandler,
} from './fastifyRouteTypes.js'

// Route utilities
export {
  createSSEContext,
  determineMode,
  determineSyncFormat,
  handleReconnection,
  handleSSEError,
  isErrorLike,
  type SSECloseReason,
  type SSEContextResult,
  type SSEControllerLike,
  type SSELifecycleOptions,
  type SSEReply,
  type SSESessionSetupResult,
  type SyncFormatResult,
  sendReplayEvents,
  setupSSESession,
} from './fastifyRouteUtils.js'
