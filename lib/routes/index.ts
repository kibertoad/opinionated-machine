// Unified route builder
export { buildFastifyRoute, extractPathTemplate } from './fastifyRouteBuilder.js'

// Route types
export {
  type BuildFastifyDualModeRoutesReturnType,
  type BuildFastifySSERoutesReturnType,
  buildDualModeHandler,
  buildFastifySSEHandler,
  type DualModeHandlers,
  type FastifyDualModeHandlerConfig,
  type FastifyDualModeRouteOptions,
  type FastifySSEHandlerConfig,
  type FastifySSEPreHandler,
  type FastifySSERouteHandler,
  type FastifySSERouteOptions,
  type InferSSERequest,
  // Dual-mode types
  type JsonModeContext,
  type JsonModeHandler,
  type RegisterDualModeRoutesOptions,
  // Registration options
  type RegisterSSERoutesOptions,
  // SSE types
  type SSEConnection,
  type SSEModeContext,
  type SSEModeHandler,
} from './fastifyRouteTypes.js'

// Route utilities
export {
  determineMode,
  handleReconnection,
  handleSSEError,
  isErrorLike,
  type SSEConnectionSetupResult,
  type SSEControllerLike,
  type SSELifecycleOptions,
  type SSEReply,
  sendReplayEvents,
  setupSSEConnection,
} from './fastifyRouteUtils.js'
