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
  type SSELogContext,
  type SSERoomAdapter,
  SSERoomBroadcaster,
  SSERoomEventPublisher,
  type SSERoomEventPublisherDependencies,
  type SSERoomEventPublishOptions,
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
export type { SSELogger, SSEMessage } from './sseTypes.js'
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
