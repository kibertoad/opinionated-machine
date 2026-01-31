import type { FastifyInstance } from 'fastify'
import type { z } from 'zod'
import type { SSEContractDefinition, SSEPathResolver } from '../sse/sseContracts.ts'
import type { InjectPayloadSSEOptions, InjectSSEOptions, InjectSSEResult } from './sseTestTypes.ts'

/**
 * Contract type with pathResolver.
 * @internal
 */
type ContractWithPathResolver = {
  pathResolver: SSEPathResolver<unknown>
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
  Contract extends SSEContractDefinition<
    'GET',
    z.ZodTypeAny,
    z.ZodTypeAny,
    z.ZodTypeAny,
    undefined,
    Record<string, z.ZodTypeAny>
  >,
>(
  // biome-ignore lint/suspicious/noExplicitAny: Fastify instance types are complex
  app: FastifyInstance<any, any, any, any>,
  contract: Contract,
  options?: InjectSSEOptions<Contract>,
): InjectSSEResult {
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

  return { closed }
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
  Contract extends SSEContractDefinition<
    'POST' | 'PUT' | 'PATCH',
    z.ZodTypeAny,
    z.ZodTypeAny,
    z.ZodTypeAny,
    z.ZodTypeAny,
    Record<string, z.ZodTypeAny>
  >,
>(
  // biome-ignore lint/suspicious/noExplicitAny: Fastify instance types are complex
  app: FastifyInstance<any, any, any, any>,
  contract: Contract,
  options: InjectPayloadSSEOptions<Contract>,
): InjectSSEResult {
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

  return { closed }
}
