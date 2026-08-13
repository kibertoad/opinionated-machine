import type {
  EventPayloadMap,
  FallbackBindingConfig,
  InferContractEvents,
  InferContractSnapshot,
  InferLegacyEvents,
  InferLegacySnapshot,
} from './bindingTypes.ts'
import type { TransportRequest } from './transport.ts'

/**
 * Symbol under which a binding is stamped on its contract(s), so server-side
 * tooling can later introspect bindings without a package dependency in
 * either direction (`Symbol.for` — shared across duplicate package copies).
 */
export const FALLBACK_BINDING_SYMBOL = Symbol.for('opinionated-machine.sse-fallback.binding')

/** Request parameters supplied when subscribing. */
export type FallbackRequestParams = {
  pathParams?: Record<string, string | number>
  queryParams?: Record<string, string | number | boolean | undefined>
  headers?: Record<string, string>
  /** Request body for payload (POST/PUT/PATCH) contracts. */
  body?: unknown
}

/**
 * A normalized fallback binding: the client core's single input shape.
 * Produced by {@link defineFallbackBinding} (dual-mode contract — the
 * primary form) or {@link bindFallbackContracts} (two separate contracts —
 * the escape hatch); both normalize to a snapshot-request builder + a
 * stream-request builder + the reconciliation config.
 */
export type FallbackBinding<
  Snapshot = unknown,
  Events extends EventPayloadMap = EventPayloadMap,
  State = undefined,
> = {
  readonly config: FallbackBindingConfig<Snapshot, Events, State>
  buildSnapshotRequest(params: FallbackRequestParams): TransportRequest
  buildStreamRequest(params: FallbackRequestParams): TransportRequest
}

// ============================================================================
// Contract introspection (structural — no runtime deps)
// ============================================================================

type ContractLike = {
  method: string
  pathResolver: (pathParams: Record<string, unknown>) => string
  responsesByStatusCode?: Record<string, unknown>
  /** Legacy contract markers */
  isSSE?: boolean
  isDualMode?: boolean
  successResponseBodySchema?: unknown
  serverSentEventSchemas?: unknown
}

const SUCCESS_STATUS_CODES = [200, 201, 202, 203, 206, 207, 208, 226]

function isSseBodyDescriptor(value: unknown): boolean {
  return (
    typeof value === 'object' && value !== null && (value as { _tag?: unknown })._tag === 'SseBody'
  )
}

type ResponseShape = { hasSse: boolean; hasNonSse: boolean }

function inspectResponseEntry(entry: unknown, shape: ResponseShape): void {
  const content = (entry as { content?: Record<string, unknown> }).content
  if (!content || typeof content !== 'object') {
    // A bare schema entry is a JSON response.
    shape.hasNonSse = true
    return
  }
  for (const descriptor of Object.values(content)) {
    if (isSseBodyDescriptor(descriptor)) shape.hasSse = true
    else shape.hasNonSse = true
  }
  if ((entry as { allowNoBody?: boolean }).allowNoBody) shape.hasNonSse = true
}

function inspectApiContractResponses(contract: ContractLike): ResponseShape {
  const shape: ResponseShape = { hasSse: false, hasNonSse: false }
  for (const code of SUCCESS_STATUS_CODES) {
    const entry = contract.responsesByStatusCode?.[String(code)]
    if (entry !== undefined) {
      inspectResponseEntry(entry, shape)
    }
  }
  return shape
}

function validateConfig(config: FallbackBindingConfig<never, EventPayloadMap, unknown>): void {
  const hasMapper = config.snapshotToEvents !== undefined
  const hasShorthand = config.snapshotEvent !== undefined
  if (hasMapper === hasShorthand) {
    throw new Error(
      'FallbackBindingConfig requires exactly one of snapshotToEvents / snapshotEvent.',
    )
  }
}

/** Expand the `snapshotEvent` shorthand into `snapshotToEvents`. */
function normalizeConfig<Snapshot, Events extends EventPayloadMap, State>(
  config: FallbackBindingConfig<Snapshot, Events, State>,
): FallbackBindingConfig<Snapshot, Events, State> {
  validateConfig(config as FallbackBindingConfig<never, EventPayloadMap, unknown>)
  if (config.snapshotEvent === undefined) return config
  const eventName = config.snapshotEvent
  return {
    ...config,
    snapshotToEvents: (snapshot) => [
      { event: eventName, data: snapshot as Events[typeof eventName] },
    ],
  }
}

function stringifyQuery(
  queryParams: FallbackRequestParams['queryParams'],
): Record<string, string> | undefined {
  if (!queryParams) return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(queryParams)) {
    if (value === undefined) continue
    out[key] = String(value)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function buildRequest(contract: ContractLike, params: FallbackRequestParams): TransportRequest {
  return {
    path: contract.pathResolver(params.pathParams ?? {}),
    method: contract.method,
    ...(stringifyQuery(params.queryParams) ? { query: stringifyQuery(params.queryParams) } : {}),
    ...(params.headers ? { headers: params.headers } : {}),
    ...(params.body !== undefined ? { body: params.body } : {}),
  }
}

function stampBinding(contract: object, binding: object): void {
  Object.defineProperty(contract, FALLBACK_BINDING_SYMBOL, {
    value: binding,
    enumerable: false,
    configurable: true,
    writable: true,
  })
}

/** Read a binding previously stamped on a contract, or `undefined`. */
export function readFallbackBinding(contract: object): FallbackBinding | undefined {
  return (contract as Record<symbol, FallbackBinding | undefined>)[FALLBACK_BINDING_SYMBOL]
}

// ============================================================================
// Primary form: one dual-mode contract IS the binding
// ============================================================================

/**
 * Declare a fallback binding on a dual-mode `defineApiContract` contract —
 * one path serving JSON (the poll) and SSE (the push) via Accept
 * negotiation. Snapshot and event types are inferred from the contract.
 *
 * @example
 * ```ts
 * export const uploadStatusBinding = defineFallbackBinding(uploadStatusContract, {
 *   snapshotToEvents: (s) =>
 *     s.status === 'completed' ? [{ event: 'uploadFinished', data: { result: s.result } }] : [],
 *   version: { ofSnapshot: (s) => s.version },
 *   terminalEvents: ['uploadFinished', 'uploadFailed'],
 * })
 * ```
 */
export function defineFallbackBinding<
  TContract extends { method: string; pathResolver: (p: never) => string },
  Snapshot = InferContractSnapshot<TContract>,
  Events extends EventPayloadMap = InferContractEvents<TContract>,
  State = undefined,
>(
  contract: TContract,
  // NoInfer: Snapshot/Events come from the CONTRACT (via the defaults), never
  // widened from whatever the config functions happen to mention.
  config: FallbackBindingConfig<NoInfer<Snapshot>, NoInfer<Events>, State>,
): FallbackBinding<Snapshot, Events, State> {
  const contractLike = contract as unknown as ContractLike
  const shape = inspectApiContractResponses(contractLike)
  const isLegacyDual = contractLike.isDualMode === true
  if (!isLegacyDual && !(shape.hasSse && shape.hasNonSse)) {
    throw new Error(
      'defineFallbackBinding requires a dual-mode contract (a success response with both an SSE and a non-SSE representation). ' +
        'For separate poll/stream contracts use bindFallbackContracts; for legacy dual-mode contracts use fromLegacyDualModeContract.',
    )
  }

  const normalized = normalizeConfig(config)
  const binding: FallbackBinding<Snapshot, Events, State> = {
    config: normalized,
    buildSnapshotRequest: (params) => buildRequest(contractLike, params),
    buildStreamRequest: (params) => buildRequest(contractLike, params),
  }
  stampBinding(contract, binding)
  return binding
}

// ============================================================================
// Escape hatch: two separate contracts
// ============================================================================

export type BindFallbackContractsOptions<Snapshot, Events extends EventPayloadMap, State> = {
  /**
   * Map the subscription params onto each contract's params when their
   * request shapes differ. Defaults to passing params through unchanged.
   */
  mapParams?: {
    toSnapshot?: (params: FallbackRequestParams) => FallbackRequestParams
    toStream?: (params: FallbackRequestParams) => FallbackRequestParams
  }
} & FallbackBindingConfig<Snapshot, Events, State>

/**
 * Escape hatch: bind two PRE-EXISTING contracts — a plain REST contract (the
 * poll) and an SSE contract (the push) on different paths. Prefer the
 * single dual-mode contract form (`defineFallbackBinding`) for new
 * endpoints: one contract cannot drift against itself.
 */
export function bindFallbackContracts<
  TPoll extends { method: string; pathResolver: (p: never) => string },
  TStream extends { method: string; pathResolver: (p: never) => string },
  Snapshot = InferContractSnapshot<TPoll>,
  Events extends EventPayloadMap = [InferContractEvents<TStream>] extends [never]
    ? InferLegacyEvents<TStream>
    : InferContractEvents<TStream>,
  State = undefined,
>(
  poll: TPoll,
  stream: TStream,
  options: BindFallbackContractsOptions<NoInfer<Snapshot>, NoInfer<Events>, State>,
): FallbackBinding<Snapshot, Events, State> {
  const pollLike = poll as unknown as ContractLike
  const streamLike = stream as unknown as ContractLike

  const pollShape = inspectApiContractResponses(pollLike)
  if (pollShape.hasSse) {
    throw new Error(
      'bindFallbackContracts: the poll contract must be a plain (non-SSE) contract — its SSE responses would never be used.',
    )
  }
  const streamShape = inspectApiContractResponses(streamLike)
  const streamIsLegacySse =
    streamLike.isSSE === true ||
    streamLike.isDualMode === true ||
    streamLike.serverSentEventSchemas !== undefined
  if (!streamShape.hasSse && !streamIsLegacySse) {
    throw new Error(
      'bindFallbackContracts: the stream contract must declare an SSE success response.',
    )
  }

  const { mapParams, ...config } = options
  const normalized = normalizeConfig(config as FallbackBindingConfig<Snapshot, Events, State>)
  const toSnapshot = mapParams?.toSnapshot ?? ((params: FallbackRequestParams) => params)
  const toStream = mapParams?.toStream ?? ((params: FallbackRequestParams) => params)

  const binding: FallbackBinding<Snapshot, Events, State> = {
    config: normalized,
    buildSnapshotRequest: (params) => buildRequest(pollLike, toSnapshot(params)),
    buildStreamRequest: (params) => buildRequest(streamLike, toStream(params)),
  }
  stampBinding(poll, binding)
  stampBinding(stream, binding)
  return binding
}

// ============================================================================
// Legacy adapter
// ============================================================================

/**
 * Declare a fallback binding on a legacy `buildSseContract` dual-mode
 * contract (`successResponseBodySchema` + `serverSentEventSchemas`).
 */
export function fromLegacyDualModeContract<
  TContract extends {
    method: string
    pathResolver: (p: never) => string
    isDualMode: boolean
  },
  Snapshot = InferLegacySnapshot<TContract>,
  Events extends EventPayloadMap = InferLegacyEvents<TContract>,
  State = undefined,
>(
  contract: TContract,
  config: FallbackBindingConfig<NoInfer<Snapshot>, NoInfer<Events>, State>,
): FallbackBinding<Snapshot, Events, State> {
  if (contract.isDualMode !== true) {
    throw new Error(
      'fromLegacyDualModeContract requires a legacy dual-mode contract (buildSseContract with successResponseBodySchema).',
    )
  }
  const contractLike = contract as unknown as ContractLike
  const normalized = normalizeConfig(config)
  const binding: FallbackBinding<Snapshot, Events, State> = {
    config: normalized,
    buildSnapshotRequest: (params) => buildRequest(contractLike, params),
    buildStreamRequest: (params) => buildRequest(contractLike, params),
  }
  stampBinding(contract, binding)
  return binding
}
