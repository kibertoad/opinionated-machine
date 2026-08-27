import {
  type ApiContract,
  getSseSchemaByEventName,
  type HttpStatusCode,
  type HttpStatusCodeRange,
  type ResponsesByStatusCode,
  resolveResponseEntry,
} from '@lokalise/api-contracts'
import { injectByApiContract } from '@lokalise/fastify-api-contracts'
import type { z } from 'zod'
import { parseSSEEvents } from '../sse/sseParser.ts'
import type { AnyFastifyInstance } from './AnyFastifyInstance.ts'
import type {
  ApiDeclaredResponseBody,
  ApiDeclaredResponseStatus,
  ApiSSEEvent,
  ApiSSEEventReader,
  InjectApiSSEParams,
  InjectApiSSEResult,
} from './apiSseTestTypes.ts'
import { truncateBody } from './sseInjectShared.ts'
import type { SSEResponse } from './sseTestTypes.ts'

const SSE_CONTENT_TYPE = 'text/event-stream'

/** Read a response header that light-my-request may expose as an array. */
function readHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/** Strip `; charset=…` style parameters from a media type. */
function mediaTypeOf(contentType: string | undefined): string | undefined {
  return contentType?.split(';')[0]?.trim().toLowerCase()
}

const STATUS_RANGE_KEYS: readonly HttpStatusCodeRange[] = ['1xx', '2xx', '3xx', '4xx', '5xx']

/**
 * The `responsesByStatusCode` key that serves a status, following the same
 * exact → range → `'default'` precedence as `resolveResponseEntry`.
 *
 * Diagnostics only. `resolveResponseEntry` collapses "no entry for this status" and "an entry
 * exists but none of its content-map descriptors matched the response's content-type" into a
 * single `null`; this tells the two apart so the error names the actual problem.
 */
function findResponseKeyForStatus(
  responsesByStatusCode: ResponsesByStatusCode,
  statusCode: number,
): string | undefined {
  if (responsesByStatusCode[statusCode as HttpStatusCode]) {
    return String(statusCode)
  }
  const rangeKey = STATUS_RANGE_KEYS[Math.floor(statusCode / 100) - 1]
  if (rangeKey && responsesByStatusCode[rangeKey]) {
    return rangeKey
  }
  return responsesByStatusCode.default ? 'default' : undefined
}

/**
 * The JSON schema the contract declares for the status a response actually carries, or a
 * thrown error naming why there isn't one.
 *
 * Resolution follows the same exact → range → `'default'` precedence (and content-type
 * matching) the contract client uses, so a stream on one status and JSON bodies on the others
 * resolve independently.
 */
function resolveJsonSchemaForStatus(
  responsesByStatusCode: ResponsesByStatusCode,
  statusCode: number,
  res: SSEResponse,
): z.ZodType {
  const contentType = readHeader(res.headers['content-type'])
  // Non-strict resolution: a response without a content-type still resolves to the entry's
  // declared kind, which keeps hand-rolled test handlers working.
  const resolved = resolveResponseEntry(responsesByStatusCode, statusCode, contentType, false)

  if (!resolved) {
    const declaredKey = findResponseKeyForStatus(responsesByStatusCode, statusCode)
    throw new Error(
      declaredKey === undefined
        ? `bodyForStatus(${statusCode}) — no response declared for status ${statusCode} in contract.responsesByStatusCode`
        : `bodyForStatus(${statusCode}) — the '${declaredKey}' entry of contract.responsesByStatusCode declares no body for content-type '${mediaTypeOf(contentType) ?? 'absent'}'; body: ${truncateBody(res.body)}`,
    )
  }

  if (resolved.kind !== 'json') {
    // A dual-mode status lands here: `injectApiSSE` asks for the stream, so that is what the
    // status resolved to. The type layer rules this out, so reaching it means a cast.
    const hint =
      resolved.kind === 'sse'
        ? ` — injectApiSSE requests '${SSE_CONTENT_TYPE}', so a status declaring a stream always answers with it; read it with events()`
        : ''
    throw new Error(
      `bodyForStatus(${statusCode}) — the contract declares a '${resolved.kind}' response for status ${statusCode}, not a JSON body${hint}`,
    )
  }

  return resolved.schema
}

/** JSON-parse and schema-validate a response body, reporting either failure in context. */
function parseJsonBody(schema: z.ZodType, statusCode: number, body: string): unknown {
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(body)
  } catch (err) {
    throw new Error(
      `bodyForStatus(${statusCode}) — body is not valid JSON: ${(err as Error).message}; body: ${truncateBody(body)}`,
    )
  }

  const parsed = schema.safeParse(parsedJson)
  if (!parsed.success) {
    throw new Error(
      `bodyForStatus(${statusCode}) — body does not match the declared schema: ${parsed.error.message}; body: ${truncateBody(body)}`,
    )
  }
  return parsed.data
}

/**
 * Build a `bodyForStatus` accessor bound to one `injectApiSSE` call.
 *
 * @internal Exported only for unit testing — not part of the public API
 * (the testing barrel re-exports `injectApiSSE` by name).
 */
export function bindApiBodyForStatus<Contract extends ApiContract>(
  contract: Contract,
  closed: Promise<SSEResponse>,
): InjectApiSSEResult<Contract>['bodyForStatus'] {
  // A generic arrow function can't be assigned directly to the generic method signature,
  // so the whole closure is cast once. Keep in sync with `InjectApiSSEResult['bodyForStatus']`.
  return (async <Status extends ApiDeclaredResponseStatus<Contract>>(
    statusCode: Status,
  ): Promise<ApiDeclaredResponseBody<Contract, Status>> => {
    const res = await closed
    const expected: number = statusCode
    if (res.statusCode !== expected) {
      throw new Error(
        `bodyForStatus(${expected}) — actual status ${res.statusCode}, body: ${truncateBody(res.body)}`,
      )
    }

    const schema = resolveJsonSchemaForStatus(contract.responsesByStatusCode, expected, res)
    return parseJsonBody(schema, expected, res.body) as ApiDeclaredResponseBody<Contract, Status>
  }) as InjectApiSSEResult<Contract>['bodyForStatus']
}

/**
 * Build an `events` accessor bound to one `injectApiSSE` call: parses the SSE body and
 * validates every event against the contract's `sseBody` schemas.
 *
 * @internal Exported only for unit testing — not part of the public API.
 */
export function bindApiEvents<Contract extends ApiContract>(
  contract: Contract,
  closed: Promise<SSEResponse>,
): ApiSSEEventReader<Contract> {
  return async () => {
    const res = await closed
    // Merges the SSE schemas of every declared status, not just the successful ones.
    const schemaByEventName = getSseSchemaByEventName(contract)
    if (!schemaByEventName) {
      throw new Error('events() — the contract declares no SSE response')
    }
    const contentType = mediaTypeOf(readHeader(res.headers['content-type']))
    if (contentType !== SSE_CONTENT_TYPE) {
      throw new Error(
        `events() — response is not an SSE stream (status ${res.statusCode}, content-type ${contentType ?? 'absent'}); use bodyForStatus(${res.statusCode}) for declared error responses. Body: ${truncateBody(res.body)}`,
      )
    }
    return parseSSEEvents(res.body).map((event) => {
      // An SSE event without an `event:` field is a `message` event per the spec.
      const name = event.event ?? 'message'
      const schema = schemaByEventName[name]
      if (!schema) {
        throw new Error(`events() — the contract declares no schema for event "${name}"`)
      }
      let parsedJson: unknown
      try {
        parsedJson = JSON.parse(event.data)
      } catch (err) {
        throw new Error(
          `events() — data of event "${name}" is not valid JSON: ${(err as Error).message}; data: ${truncateBody(event.data)}`,
        )
      }
      const parsed = schema.safeParse(parsedJson)
      if (!parsed.success) {
        throw new Error(
          `events() — data of event "${name}" does not match the declared schema: ${parsed.error.message}; data: ${truncateBody(event.data)}`,
        )
      }
      return {
        ...(event.id !== undefined && { id: event.id }),
        ...(event.retry !== undefined && { retry: event.retry }),
        event: name,
        data: parsed.data,
      } as ApiSSEEvent<Contract>
    })
  }
}

/**
 * Inject an SSE request using a contract built with `defineApiContract` + `sseResponse` /
 * `sseBody` (the newer `@lokalise/api-contracts` API).
 *
 * The `defineApiContract` counterpart of `injectSSE` / `injectPayloadSSE`, which are typed
 * against the legacy `SSEContractDefinition`. One function covers every method: the HTTP verb
 * comes from the contract, and `params` (`pathParams` / `queryParams` / `headers` / `body` /
 * `pathPrefix`) is the same shape `injectByApiContract` takes, so a body is required exactly
 * when the contract declares `requestBodySchema`.
 *
 * The request always carries `accept: text/event-stream` (a caller-supplied `accept` still
 * wins), so a status declaring a stream answers with it — dual-mode statuses included. Those
 * statuses expose no JSON body through `bodyForStatus`; read them with `events()`, or use
 * `injectByApiContract` when you want the JSON side.
 *
 * Best for SSE endpoints that complete — Fastify's `inject()` waits for the whole response.
 * For long-lived connections, use `SSEHttpClient` against a real HTTP server.
 *
 * @param app - Fastify instance
 * @param contract - Contract built with `defineApiContract`
 * @param params - Request params derived from the contract
 *
 * @example
 * ```typescript
 * const { closed, bodyForStatus, events } = injectApiSSE(app, lqaTextSegmentContract, {
 *   body: { segment: 'hello' },
 * })
 *
 * // Typed events, validated against the contract's sseResponse schemas
 * for (const event of await events()) {
 *   if (event.event === 'review') expect(event.data.score).toBeGreaterThan(0)
 * }
 *
 * // Or the raw body, for assertions the typed accessors don't cover
 * expect((await closed).statusCode).toBe(200)
 * ```
 *
 * @example
 * ```typescript
 * // A documented pre-stream error response, typed by the contract's 400 schema
 * const { bodyForStatus } = injectApiSSE(app, lqaTextSegmentContract, { body: { segment: '' } })
 * const error = await bodyForStatus(400)
 * expect(error.message).toBe('segment must not be empty')
 * ```
 */
export function injectApiSSE<const Contract extends ApiContract>(
  app: AnyFastifyInstance,
  contract: Contract,
  params: InjectApiSSEParams<Contract>,
): InjectApiSSEResult<Contract> {
  // biome-ignore lint/suspicious/noExplicitAny: params shape depends on the contract
  const requestParams = params as any

  const closed = injectByApiContract(app, contract, {
    ...requestParams,
    // `accept` first so an explicit caller header still wins; headers may be a factory,
    // which `injectByApiContract` resolves for us — resolve the caller's here too.
    headers: async () => ({
      accept: SSE_CONTENT_TYPE,
      ...(typeof requestParams.headers === 'function'
        ? await requestParams.headers()
        : requestParams.headers),
    }),
  }).then((res) => ({
    statusCode: res.statusCode,
    headers: res.headers as Record<string, string | string[] | undefined>,
    body: res.body,
  }))

  return {
    closed,
    bodyForStatus: bindApiBodyForStatus(contract, closed),
    // `events` is typed `never` for contracts that declare no SSE response, which no concrete
    // function satisfies — the binder returns the callable form and it is narrowed here.
    events: bindApiEvents(contract, closed) as InjectApiSSEResult<Contract>['events'],
  }
}
