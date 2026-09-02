// Re-exported so a transport author does not have to add the parser package
// as a second dependency to frame a stream by hand.
export {
  createSSEStreamParser,
  type ParsedSSEEvent,
  type ParseSSEBufferResult,
  type ParseSSEStreamOptions,
  parseSSEBuffer,
  parseSSEResponse,
  parseSSEStream,
  type SSEStreamParser,
} from '@opinionated-machine/sse-parser'
export {
  type BindFallbackContractsOptions,
  bindFallbackContracts,
  defineFallbackBinding,
  FALLBACK_BINDING_SYMBOL,
  type FallbackBinding,
  type FallbackRequestParams,
  fromLegacyDualModeContract,
  readFallbackBinding,
} from './binding.ts'
export {
  type BackoffConfig,
  COMPLETION_POLICY,
  DEFAULT_POLICY,
  type EventPayloadMap,
  type FallbackBindingConfig,
  type FallbackEvent,
  type FallbackEventOrigin,
  type FallbackPolicy,
  type InferContractEvents,
  type InferContractSnapshot,
  type InferLegacyEvents,
  type InferLegacySnapshot,
  LIVE_STATE_POLICY,
  POLL_ONLY_POLICY,
  type SubscriptionBudget,
  type SyntheticEvent,
  type Version,
  type VersionConfig,
} from './bindingTypes.ts'
export { createPollGate, type PollGate, type PollGateConfig } from './pollGate.ts'
export {
  defaultCompareVersions,
  type EventOutcome,
  type IncomingEvent,
  type InvalidVersionInfo,
  Reconciler,
  type SnapshotOutcome,
  type VersionGap,
} from './reconciler.ts'
export { backoffDelay, ResettableTimer, sleep } from './scheduler.ts'
export {
  type CreateResilientSubscriptionOptions,
  createResilientSubscription,
  type FallbackDiagnostics,
  type ResilientSubscription,
  type StopReason,
  type SubscriptionStatus,
  type SubscriptionStopDetail,
  SubscriptionStoppedError,
} from './subscription.ts'
export {
  type FallbackTransport,
  isParsedStreamResponse,
  type ParsedSseFrame,
  type ParsedStreamResponse,
  type RawStreamResponse,
  type SnapshotResponse,
  type StreamResponse,
  type TestSnapshotCall,
  type TestStreamHandle,
  TestTransport,
  type TransportRequest,
} from './transport.ts'
