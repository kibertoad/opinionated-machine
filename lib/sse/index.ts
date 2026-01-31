// Re-export buildContract from contracts module
export { buildContract } from '../contracts/index.js'
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
export { buildFastifySSERoute, type RegisterSSERoutesOptions } from './fastifySSERouteBuilder.js'
// Fastify-specific types
export {
  type BuildFastifySSERoutesReturnType,
  buildFastifySSEHandler,
  type FastifySSEHandlerConfig,
  type FastifySSEPreHandler,
  type FastifySSERouteHandler,
  type FastifySSERouteOptions,
  type InferSSERequest,
  type SSEConnection,
} from './fastifySSETypes.js'
export { type SSEConnectionEvent, SSEConnectionSpy } from './SSEConnectionSpy.js'
export type {
  AnySSEContractDefinition,
  PayloadSSEContractConfig,
  SSEContractConfig,
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
