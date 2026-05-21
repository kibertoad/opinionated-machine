import type {
  HttpStatusCode,
  RoutePathResolver,
  SSEContractDefinition,
} from '@lokalise/api-contracts'
import type { z } from 'zod'
import type { AnyFastifyInstance } from './AnyFastifyInstance.ts'
import type {
  DeclaredResponseBody,
  DeclaredResponseStatus,
  InjectPayloadSSEOptions,
  InjectSSEOptions,
  InjectSSEResult,
  SSEResponse,
} from './sseTestTypes.ts'

/** Truncate a long body string for error messages. */
const BODY_TRUNCATE_LIMIT = 500
const truncateBody = (body: string): string => {
  if (body.length <= BODY_TRUNCATE_LIMIT) {
    return body
  }
  // Step back one unit if the cut would split a surrogate pair, so the
  // snippet never ends in a lone (invalid) surrogate.
  const lastCode = body.charCodeAt(BODY_TRUNCATE_LIMIT - 1)
  const end =
    lastCode >= 0xd800 && lastCode <= 0xdbff ? BODY_TRUNCATE_LIMIT - 1 : BODY_TRUNCATE_LIMIT
  return `${body.slice(0, end)}…`
}

/**
 * Build a `bodyForStatus` accessor bound to one inject call. The closure
 * captures the contract's schemas map so the resulting helper knows which
 * schemas to parse against; at the type level the caller is constrained to
 * status codes the contract actually declares.
 *
 * @internal Exported only for unit testing — not part of the public API
 * (the testing barrel re-exports `injectSSE`/`injectPayloadSSE` by name).
 */
export function bindBodyForStatus<
  Schemas extends Partial<Record<HttpStatusCode, z.ZodTypeAny>> | undefined,
>(
  contract: { responseBodySchemasByStatusCode?: Schemas },
  closed: Promise<SSEResponse>,
): InjectSSEResult<Schemas>['bodyForStatus'] {
  // A generic arrow function can't be assigned directly to the generic
  // method signature, so the whole closure is cast once. Keep this
  // implementation in sync with `InjectSSEResult['bodyForStatus']`.
  return (async <Status extends DeclaredResponseStatus<Schemas>>(
    statusCode: Status,
  ): Promise<DeclaredResponseBody<Schemas, Status>> => {
    const res = await closed
    const expected: number = statusCode
    if (res.statusCode !== expected) {
      throw new Error(
        `bodyForStatus(${expected}) — actual status ${res.statusCode}, body: ${truncateBody(res.body)}`,
      )
    }
    // Widen the generic schemas map to a concrete type so it can be indexed.
    const schemas: Partial<Record<HttpStatusCode, z.ZodTypeAny>> | undefined =
      contract.responseBodySchemasByStatusCode
    const schema = schemas?.[expected as HttpStatusCode]
    if (!schema) {
      throw new Error(
        `bodyForStatus(${expected}) — no response body schema declared for status ${expected} in contract.responseBodySchemasByStatusCode`,
      )
    }
    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(res.body)
    } catch (err) {
      throw new Error(
        `bodyForStatus(${expected}) — body is not valid JSON: ${(err as Error).message}; body: ${truncateBody(res.body)}`,
      )
    }
    const parsed = schema.safeParse(parsedJson)
    if (!parsed.success) {
      throw new Error(
        `bodyForStatus(${expected}) — body does not match the declared schema: ${parsed.error.message}; body: ${truncateBody(res.body)}`,
      )
    }
    return parsed.data as DeclaredResponseBody<Schemas, Status>
  }) as InjectSSEResult<Schemas>['bodyForStatus']
}

/**
 * Contract type with pathResolver.
 * @internal
 */
type ContractWithPathResolver = {
  pathResolver: RoutePathResolver<unknown>
}

/**
 * Build query string from query params object.
 * @internal
 */
function buildQueryString(query: Record<string, unknown>): string {
  const searchParams = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) {
      searchParams.append(key, String(value))
    }
  }
  return searchParams.toString()
}

/**
 * Build URL from contract pathResolver and params.
 * @internal
 */
function buildUrl<Contract extends ContractWithPathResolver>(
  contract: Contract,
  params?: Record<string, string>,
  query?: Record<string, unknown>,
): string {
  let url = contract.pathResolver(params ?? {})

  // Append query string if present
  if (query && Object.keys(query).length > 0) {
    const queryString = buildQueryString(query)
    if (queryString) {
      url = `${url}?${queryString}`
    }
  }

  return url
}

/**
 * Inject a GET SSE request using a contract definition.
 *
 * Best for testing SSE endpoints that complete (streaming responses).
 * For long-lived connections, use `connectSSE` with a real HTTP server.
 *
 * @param app - Fastify instance
 * @param contract - SSE route contract
 * @param options - Request options (params, query, headers)
 *
 * @example
 * ```typescript
 * const { closed } = injectSSE(app, streamContract, {
 *   query: { userId: 'user-123' },
 * })
 * const result = await closed
 * const events = parseSSEEvents(result.body)
 * ```
 */
export function injectSSE<
  // `Contract` must be the only inferred type parameter: the schemas map is
  // derived from it via indexed access below. Declaring `Schemas` as its own
  // parameter leaves it in a non-inferable position (it only appears in
  // `Contract`'s constraint), so TS would silently widen it to the constraint
  // and `bodyForStatus` would lose all of its type safety.
  Contract extends SSEContractDefinition<
    'get',
    z.ZodTypeAny,
    z.ZodTypeAny,
    z.ZodTypeAny,
    undefined,
    Record<string, z.ZodTypeAny>,
    Partial<Record<HttpStatusCode, z.ZodTypeAny>> | undefined
  >,
>(
  app: AnyFastifyInstance,
  contract: Contract,
  options?: InjectSSEOptions<Contract>,
): InjectSSEResult<Contract['responseBodySchemasByStatusCode']> {
  const url = buildUrl(
    contract,
    options?.params as Record<string, string> | undefined,
    options?.query as Record<string, unknown> | undefined,
  )

  // Start the request - this promise resolves when connection closes
  const closed = app
    .inject({
      method: 'GET',
      url,
      headers: {
        accept: 'text/event-stream',
        ...(options?.headers as Record<string, string> | undefined),
      },
    })
    .then((res) => ({
      statusCode: res.statusCode,
      headers: res.headers as Record<string, string | string[] | undefined>,
      body: res.body,
    }))

  return { closed, bodyForStatus: bindBodyForStatus(contract, closed) }
}

/**
 * Inject a POST/PUT/PATCH SSE request using a contract definition.
 *
 * This helper is designed for testing OpenAI-style streaming APIs where
 * the request includes a body and the response streams events.
 *
 * @param app - Fastify instance
 * @param contract - SSE route contract with body
 * @param options - Request options (params, query, headers, body)
 *
 * @example
 * ```typescript
 * // Fire the SSE request
 * const { closed } = injectPayloadSSE(app, chatCompletionContract, {
 *   body: { message: 'Hello', stream: true },
 *   headers: { authorization: 'Bearer token' },
 * })
 *
 * // Wait for streaming to complete and get full response
 * const result = await closed
 * const events = parseSSEEvents(result.body)
 *
 * expect(events).toContainEqual(
 *   expect.objectContaining({ event: 'chunk' })
 * )
 * ```
 */
export function injectPayloadSSE<
  // See `injectSSE` above: `Contract` is the only inferred parameter so the
  // schemas map can be derived from it via indexed access.
  Contract extends SSEContractDefinition<
    'post' | 'put' | 'patch',
    z.ZodTypeAny,
    z.ZodTypeAny,
    z.ZodTypeAny,
    z.ZodTypeAny,
    Record<string, z.ZodTypeAny>,
    Partial<Record<HttpStatusCode, z.ZodTypeAny>> | undefined
  >,
>(
  app: AnyFastifyInstance,
  contract: Contract,
  options: InjectPayloadSSEOptions<Contract>,
): InjectSSEResult<Contract['responseBodySchemasByStatusCode']> {
  const url = buildUrl(
    contract,
    options.params as Record<string, string> | undefined,
    options.query as Record<string, unknown> | undefined,
  )

  const closed = app
    .inject({
      method: contract.method,
      url,
      headers: {
        accept: 'text/event-stream',
        'content-type': 'application/json',
        ...(options.headers as Record<string, string> | undefined),
      },
      payload: JSON.stringify(options.body),
    })
    .then((res) => ({
      statusCode: res.statusCode,
      headers: res.headers as Record<string, string | string[] | undefined>,
      body: res.body,
    }))

  return { closed, bodyForStatus: bindBodyForStatus(contract, closed) }
}
