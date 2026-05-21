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
const truncateBody = (body: string): string =>
  body.length <= BODY_TRUNCATE_LIMIT ? body : `${body.slice(0, BODY_TRUNCATE_LIMIT)}…`

/**
 * Build a `bodyForStatus` accessor bound to one inject call. The closure
 * captures the contract's schemas map so the resulting helper knows which
 * schemas to parse against; at the type level the caller is constrained to
 * status codes the contract actually declares.
 */
function bindBodyForStatus<
  Schemas extends Partial<Record<HttpStatusCode, z.ZodTypeAny>> | undefined,
>(
  contract: { responseBodySchemasByStatusCode?: Schemas },
  closed: Promise<SSEResponse>,
): InjectSSEResult<Schemas>['bodyForStatus'] {
  return (async <Status extends DeclaredResponseStatus<Schemas>>(
    statusCode: Status,
  ): Promise<DeclaredResponseBody<Schemas, Status>> => {
    const res = await closed
    const expected = statusCode as unknown as number
    if (res.statusCode !== expected) {
      throw new Error(
        `bodyForStatus(${expected}) — actual status ${res.statusCode}, body: ${truncateBody(res.body)}`,
      )
    }
    const schemas = contract.responseBodySchemasByStatusCode as
      | Partial<Record<HttpStatusCode, z.ZodTypeAny>>
      | undefined
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
    return schema.parse(parsedJson) as DeclaredResponseBody<Schemas, Status>
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
  Schemas extends Partial<Record<HttpStatusCode, z.ZodTypeAny>> | undefined,
  Contract extends SSEContractDefinition<
    'get',
    z.ZodTypeAny,
    z.ZodTypeAny,
    z.ZodTypeAny,
    undefined,
    Record<string, z.ZodTypeAny>,
    Schemas
  >,
>(
  app: AnyFastifyInstance,
  contract: Contract,
  options?: InjectSSEOptions<Contract>,
): InjectSSEResult<Schemas> {
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
  Schemas extends Partial<Record<HttpStatusCode, z.ZodTypeAny>> | undefined,
  Contract extends SSEContractDefinition<
    'post' | 'put' | 'patch',
    z.ZodTypeAny,
    z.ZodTypeAny,
    z.ZodTypeAny,
    z.ZodTypeAny,
    Record<string, z.ZodTypeAny>,
    Schemas
  >,
>(
  app: AnyFastifyInstance,
  contract: Contract,
  options: InjectPayloadSSEOptions<Contract>,
): InjectSSEResult<Schemas> {
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
