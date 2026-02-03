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
  // Multi-format handler types (deprecated)
  type FormatHandler,
  type InferDualModeHandlers,
  type InferHandlers,
  type InferSSERequest,
  // Dual-mode types (deprecated alias)
  type JsonModeHandler,
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
  // Multi-format sync handlers type (deprecated)
  type SyncHandlers,
  // Sync mode handler type (renamed from JsonModeHandler)
  type SyncModeHandler,
  type VerboseDualModeHandlers,
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
