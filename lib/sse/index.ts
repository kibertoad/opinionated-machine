// Re-export buildContract from contracts module
export { buildContract } from '../contracts/index.js'
// Re-export route types from routes module
export {
  type BuildFastifySSERoutesReturnType,
  buildFastifyRoute,
  buildHandler,
  type FastifySSEHandlerConfig,
  type FastifySSEPreHandler,
  type FastifySSERouteHandler,
  type FastifySSERouteOptions,
  type InferSSERequest,
  type RegisterSSERoutesOptions,
  type SSEConnection,
  type SSEOnlyHandlers,
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
export { type SSEConnectionEvent, SSEConnectionSpy } from './SSEConnectionSpy.js'
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
