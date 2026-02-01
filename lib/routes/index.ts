// Re-export Either utilities from @lokalise/node-core for SSE handler results
export { type Either, failure, success } from '@lokalise/node-core'

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
  type SSEConnection,
  // SSE handler result types
  type SSEHandlerDisconnect,
  type SSEHandlerMaintainConnection,
  type SSEHandlerResult,
  type SSEModeHandler,
  type SSEOnlyHandlers,
  // SSE stream message type
  type SSEStreamMessage,
  // Multi-format sync handlers type
  type SyncHandlers,
  type VerboseDualModeHandlers,
} from './fastifyRouteTypes.js'

// Route utilities
export {
  determineMode,
  determineSyncFormat,
  handleReconnection,
  handleSSEError,
  isErrorLike,
  type SSEConnectionSetupResult,
  type SSEControllerLike,
  type SSELifecycleOptions,
  type SSEReply,
  type SyncFormatResult,
  sendReplayEvents,
  setupSSEConnection,
} from './fastifyRouteUtils.js'
