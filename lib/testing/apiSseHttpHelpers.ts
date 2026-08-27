import { type ApiContract, buildRequestPath } from '@lokalise/api-contracts'
import type { SpiedSSESession, SSESessionSpy } from '../sse/SSESessionSpy.ts'
import {
  describeSendFailures,
  openSSEDiagnosticsScope,
  type SSEDiagnosticsScope,
} from '../sse/sseSendDiagnostics.ts'
import type { ApiSSEEvent, InjectApiSSEParams } from './apiSseTestTypes.ts'
import { SSEHttpClient, type SSEHttpConnectOptions, type SSEHttpMethod } from './sseHttpClient.ts'

/**
 * Request params for {@link connectApiSSE}, derived from a `defineApiContract` contract.
 *
 * The same shape `injectApiSSE` takes — `pathParams`, `body`, `queryParams` and `headers` are
 * each required only when the contract declares the matching request schema, `headers` also
 * accepts a (sync or async) factory, and `pathPrefix` is always optional.
 */
export type ConnectApiSSEParams<Contract extends ApiContract> = InjectApiSSEParams<Contract>

/** Options for waiting on server-side registration, driven by a standalone session spy. */
export type ConnectApiSSEWithSpyOptions<TSession extends SpiedSSESession> = {
  /**
   * Wait for server-side connection registration after HTTP headers are received, removing
   * the race between `connect()` returning and the handler finishing its registration.
   *
   * Only meaningful for `keepAlive` sessions — an `autoClose` route closes its session as the
   * handler returns, before the wait can claim it.
   */
  awaitServerConnection: {
    /** A standalone spy, wired to the route via `createSSESessionSpy()`'s `routeOptions` */
    spy: SSESessionSpy<TSession>
    /** Timeout in milliseconds (default: 5000) */
    timeout?: number
  }
}

/** Result of {@link connectApiSSE} when `awaitServerConnection` is used. */
export type ConnectApiSSEResult<Contract extends ApiContract, TSession extends SpiedSSESession> = {
  client: ApiSSEHttpClient<Contract>
  serverConnection: TSession
}

/**
 * A live SSE connection over real HTTP, read through the contract that declares it.
 *
 * The contract-typed counterpart of {@link SSEHttpClient}: events arrive incrementally, as
 * they do there, but each one is JSON-parsed, validated against the contract's `sseResponse` /
 * `sseBody` schemas and typed as a discriminated union on `event` — the same events
 * `injectApiSSE` produces, so a suite can move an assertion between the two paths unchanged.
 */
export class ApiSSEHttpClient<Contract extends ApiContract> {
  /** The underlying untyped client, for the parts of it this wrapper doesn't cover. */
  readonly raw: SSEHttpClient
  private readonly contract: Contract
  private readonly scope: SSEDiagnosticsScope

  /** @internal Built by {@link connectApiSSE}. */
  constructor(raw: SSEHttpClient, contract: Contract, scope: SSEDiagnosticsScope) {
    this.raw = raw
    this.contract = contract
    this.scope = scope
  }

  /**
   * The fetch `Response`, available before any event is consumed — so status and headers can
   * be asserted while the handler is still producing events.
   */
  get response(): Response {
    return this.raw.response
  }

  /**
   * Yield the contract's events as they arrive, typed and validated per event name.
   *
   * @param signal - Optional `AbortSignal` to stop the generator early
   *
   * @example
   * ```typescript
   * for await (const event of client.events()) {
   *   if (event.event === 'issue') expect(event.data.severity).toBe('minor')
   *   if (event.event === 'review') break
   * }
   * ```
   */
  async *events(signal?: AbortSignal): AsyncGenerator<ApiSSEEvent<Contract>, void, unknown> {
    yield* this.raw.apiEvents(this.contract, signal)

    if (!signal?.aborted) {
      // The server ended the stream: anything the handler failed to send is known now, and
      // is why an expected event never arrived.
      this.assertNoSendFailures('events()')
    }
  }

  /**
   * Collect events until a count is reached or a predicate matches, each one typed and
   * validated against the contract.
   *
   * A collection that ends short — the stream closed early, or the wait timed out — usually
   * means the handler failed to send an event it was supposed to; when that is what happened,
   * the thrown error names the event and its validation issues instead of leaving the test to
   * report a missing event with no reason.
   *
   * @param countOrPredicate - Number of events to collect, or a predicate that ends collection
   *   (the matching event is included)
   * @param timeout - Maximum time to wait in milliseconds (default: 5000)
   */
  async collectEvents(
    countOrPredicate: number | ((event: ApiSSEEvent<Contract>) => boolean),
    timeout?: number,
  ): Promise<ApiSSEEvent<Contract>[]> {
    let collected: ApiSSEEvent<Contract>[]
    try {
      collected = await this.raw.collectApiEvents(this.contract, countOrPredicate, timeout)
    } catch (err) {
      const failures = this.scope.failures()
      if (failures.length === 0) {
        throw err
      }
      throw new Error(
        `collectEvents() — ${describeSendFailures(failures)}\nRaised while collecting: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    // `collectEvents` also returns short when the server closed the stream before the target
    // was met, which is exactly what a failed send looks like from here.
    const satisfied =
      typeof countOrPredicate === 'number'
        ? collected.length >= countOrPredicate
        : collected.some(countOrPredicate)
    if (!satisfied) {
      this.assertNoSendFailures('collectEvents()')
    }

    return collected
  }

  /** Throw what the handler failed to send, if anything was recorded for this connection. */
  private assertNoSendFailures(reader: string): void {
    const failures = this.scope.failures()
    if (failures.length > 0) {
      throw new Error(`${reader} — ${describeSendFailures(failures)}`)
    }
  }

  /**
   * The sends the handler could not make on this connection — a payload that failed the
   * contract's schema for its event, say — recorded instead of being left in the server log.
   *
   * Only routes built with this package's `buildApiRoute` report them.
   */
  sendFailures() {
    return this.scope.failures()
  }

  /** Close the connection from the client side. */
  close(): void {
    this.scope.dispose()
    this.raw.close()
  }
}

/**
 * Connect to an SSE endpoint over real HTTP using a contract built with `defineApiContract`.
 *
 * The contract-aware counterpart of `SSEHttpClient.connect`: the method, path, query params,
 * headers and body all come from the contract instead of being repeated as string literals
 * next to it, and the events are typed and validated the way `injectApiSSE().events()` types
 * them — so the tests that read a stream as it arrives keep the contract typing rather than
 * casting `ParsedSSEEvent.data` by hand.
 *
 * Use this (over `injectApiSSE`) when the endpoint keeps its connection open: a `keepAlive`
 * session never completes its response, so only a real HTTP connection can read it.
 *
 * @param baseUrl - Base URL of the running server (e.g. `SSETestServer.baseUrl`)
 * @param contract - Contract built with `defineApiContract`
 * @param params - Request params derived from the contract
 * @param options - `awaitServerConnection`, to also wait for server-side registration
 *
 * @example
 * ```typescript
 * const client = await connectApiSSE(server.baseUrl, lqaTextSegmentContract, { body })
 *
 * expect(client.response.status).toBe(200)  // asserted while the handler is still working
 * for await (const event of client.events()) {
 *   if (event.event === 'issue') expect(event.data.severity).toBe('minor')  // typed
 * }
 * client.close()
 * ```
 *
 * @example
 * ```typescript
 * // keepAlive route: wait for the server-side session, then drive it from the test
 * const { spy, routeOptions } = createSSESessionSpy()
 * const { client, serverConnection } = await connectApiSSE(
 *   server.baseUrl,
 *   tickStreamContract,
 *   { pathParams: { channelId: 'c1' }, queryParams: { count: 2 }, headers },
 *   { awaitServerConnection: { spy } },
 * )
 * await serverConnection.send('tick', { channelId: 'c1', n: 1 })
 * ```
 */
export async function connectApiSSE<const Contract extends ApiContract>(
  baseUrl: string,
  contract: Contract,
  params: ConnectApiSSEParams<Contract>,
): Promise<ApiSSEHttpClient<Contract>>
export async function connectApiSSE<
  const Contract extends ApiContract,
  TSession extends SpiedSSESession,
>(
  baseUrl: string,
  contract: Contract,
  params: ConnectApiSSEParams<Contract>,
  options: ConnectApiSSEWithSpyOptions<TSession>,
): Promise<ConnectApiSSEResult<Contract, TSession>>
export async function connectApiSSE<
  const Contract extends ApiContract,
  TSession extends SpiedSSESession,
>(
  baseUrl: string,
  contract: Contract,
  params: ConnectApiSSEParams<Contract>,
  options?: ConnectApiSSEWithSpyOptions<TSession>,
): Promise<ApiSSEHttpClient<Contract> | ConnectApiSSEResult<Contract, TSession>> {
  // biome-ignore lint/suspicious/noExplicitAny: params shape depends on the contract
  const requestParams = params as any
  const path = buildRequestPath(
    contract.pathResolver(requestParams.pathParams),
    requestParams.pathPrefix,
  )
  // `headers` may be a factory, exactly as the contract client and `injectApiSSE` accept it.
  const callerHeaders =
    typeof requestParams.headers === 'function'
      ? await requestParams.headers()
      : requestParams.headers

  // Records the sends the handler could not make, matched to this connection by a header the
  // route builder honours only for scopes open in this process.
  const scope = openSSEDiagnosticsScope()

  const connectOptions: SSEHttpConnectOptions = {
    method: contract.method as SSEHttpMethod,
    headers: { ...callerHeaders, ...scope.headers },
    ...(requestParams.queryParams !== undefined && { query: requestParams.queryParams }),
    ...(requestParams.body !== undefined && { body: requestParams.body }),
  }

  if (!options) {
    const raw = await SSEHttpClient.connect(baseUrl, path, connectOptions)
    return new ApiSSEHttpClient(raw, contract, scope)
  }

  try {
    const { client: raw, serverConnection } = await SSEHttpClient.connect<TSession>(baseUrl, path, {
      ...connectOptions,
      awaitServerConnection: options.awaitServerConnection,
    })
    return { client: new ApiSSEHttpClient(raw, contract, scope), serverConnection }
  } catch (error) {
    scope.dispose()
    throw error
  }
}
