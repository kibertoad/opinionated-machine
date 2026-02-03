// Re-export buildContract from contracts module
export { buildContract } from '../contracts/index.js'
// Re-export route types from routes module
export {
  type BuildFastifySSERoutesReturnType,
  buildFastifyRoute,
  buildHandler,
  type FastifySSEHandlerConfig,
  type FastifySSEPreHandler,
  type FastifySSERouteOptions,
  type InferSSERequest,
  type RegisterSSERoutesOptions,
  type SSEOnlyHandlers,
  type SSESession,
} from '../routes/index.js'
export {
  AbstractSSEController,
  type AllContractEventNames,
  type AllContractEvents,
  type ExtractEventSchema,
  type SSEControllerConfig,
  type SSEEventSchemas,
  type SSEEventSender,
  type SSELogger,
  type SSEMessage,
} from './AbstractSSEController.js'
export { type SSESessionEvent, SSESessionSpy } from './SSESessionSpy.js'
export type {
  AnySSEContractDefinition,
  SSEContractDefinition,
  SSEMethod,
  SSEPathResolver,
} from './sseContracts.js'
export {
  type ParsedSSEEvent,
  type ParseSSEBufferResult,
  parseSSEBuffer,
  parseSSEEvents,
} from './sseParser.js'
