// Re-export contract types from @lokalise/api-contracts
export type {
  AllContractEventNames,
  AllContractEvents,
  AnySSEContractDefinition,
  ExtractEventSchema,
  SSEContractDefinition,
  SSEEventSchemas,
  SSEMethod,
} from '@lokalise/api-contracts'
// The wire-format parser lives in its own package so that the browser client
// (@opinionated-machine/sse-fallback) frames the stream with the same code the
// server's test helpers do.
export {
  createSSEStreamParser,
  type ParsedSSEEvent,
  type ParseSSEBufferResult,
  type ParseSSEStreamOptions,
  parseSSEBuffer,
  parseSSEEvents,
  parseSSEResponse,
  parseSSEStream,
  type SSEResponseLike,
  type SSEStreamParser,
  type SSEStreamParserOptions,
} from '@opinionated-machine/sse-parser'
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
  type SSEContext,
  type SSEOnlyHandlers,
  type SSERouteHandler,
  type SSESession,
} from '../routes/index.js'
export {
  AbstractSSEController,
  type SSEControllerConfig,
  type SSEEventSender,
  type SSELogger,
  type SSEMessage,
} from './AbstractSSEController.js'
export { defineEvent, type SSEEventDefinition } from './defineEvent.js'
export {
  type AsyncEventIdSequence,
  type CreateEventIdSequenceOptions,
  compareEventIds,
  createEventIdSequence,
  type EventIdSequence,
  formatEventId,
  MAX_EVENT_ID_COUNTER,
} from './eventIds.js'
// Re-export room types and classes
export {
  defineRoom,
  InMemoryAdapter,
  type PreDeliveryFilter,
  type RoomBroadcastOptions,
  type RoomNameResolver,
  type SSERoomAdapter,
  SSERoomBroadcaster,
  SSERoomManager,
  type SSERoomManagerConfig,
  type SSERoomMessageHandler,
  type SSERoomOperations,
} from './rooms/index.js'
export { type SpiedSSESession, type SSESessionEvent, SSESessionSpy } from './SSESessionSpy.js'
export {
  SSE_DIAGNOSTICS_HEADER,
  type SSEDiagnosticsScope,
  type SSESendFailure,
} from './sseSendDiagnostics.js'
// SSE Subscriptions
export {
  defineEventMetadata,
  type ExtractMetadata,
  type FilterVerdict,
  type IncomingEvent,
  type MetadataGuard,
  type MetadataGuards,
  type PublishResult,
  type ResolverResult,
  SSESubscriptionManager,
  type SSESubscriptionManagerConfig,
  type SubscriptionContext,
  type SubscriptionPolicy,
  type SubscriptionResolver,
} from './subscriptions/index.js'
