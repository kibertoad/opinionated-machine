// Unified route builder
export { buildFastifyRoute, extractPathTemplate } from './fastifyRouteBuilder.js'

// Route types
export {
  type BuildFastifyDualModeRoutesReturnType,
  type BuildFastifySSERoutesReturnType,
  // Unified handler builder
  buildHandler,
  type DualModeHandlers,
  type FastifyDualModeHandlerConfig,
  type FastifyDualModeRouteOptions,
  type FastifySSEHandlerConfig,
  type FastifySSEPreHandler,
  type FastifySSERouteOptions,
  // Multi-format handler types
  type FormatHandler,
  type InferDualModeHandlers,
  type InferHandlers,
  type InferSSERequest,
  // Dual-mode types
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
  type SSESession,
  type SSESessionMode,
  type SSEStartOptions,
  // SSE stream message type
  type SSEStreamMessage,
  // Multi-format sync handlers type
  type SyncHandlers,
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
