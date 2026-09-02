/**
 * Contract-aware SSE event validation, shared by the inject helpers (`injectApiSSE`) and the
 * real-HTTP ones (`connectApiSSE`, `SSEHttpClient.apiEvents`) so both paths produce the same
 * discriminated union, validated against the same schemas and reporting the same errors.
 *
 * @internal
 */

import type { SSEEventSchemas } from '@lokalise/api-contracts'
import { type ApiContract, getSseSchemaByEventName } from '@lokalise/api-contracts'
import type { ParsedSSEEvent } from '@opinionated-machine/sse-parser'
import type { ApiSSEEvent } from './apiSseTestTypes.ts'
import { truncateBody } from './sseInjectShared.ts'

/**
 * The contract's SSE schemas, merged across every declared status, or a thrown error naming
 * the reader that asked for them.
 */
export function resolveApiSseSchemas(contract: ApiContract, reader: string): SSEEventSchemas {
  const schemaByEventName = getSseSchemaByEventName(contract)
  if (!schemaByEventName) {
    throw new Error(`${reader} — the contract declares no SSE response`)
  }
  return schemaByEventName
}

/**
 * Validate one parsed event against the contract's schemas and return it as a member of the
 * contract's event union.
 *
 * @param reader - Name of the calling reader (`events()`, `stream()`, …), used as the error prefix
 * @throws if the contract declares no schema for the event name, if `data` isn't valid JSON,
 *   or if the payload doesn't match the declared schema
 */
export function validateApiSseEvent<Contract extends ApiContract>(
  schemaByEventName: SSEEventSchemas,
  event: ParsedSSEEvent,
  reader: string,
): ApiSSEEvent<Contract> {
  // An SSE event without an `event:` field is a `message` event per the spec.
  const name = event.event ?? 'message'
  const schema = schemaByEventName[name]
  if (!schema) {
    throw new Error(`${reader} — the contract declares no schema for event "${name}"`)
  }

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(event.data)
  } catch (err) {
    throw new Error(
      `${reader} — data of event "${name}" is not valid JSON: ${(err as Error).message}; data: ${truncateBody(event.data)}`,
    )
  }

  const parsed = schema.safeParse(parsedJson)
  if (!parsed.success) {
    throw new Error(
      `${reader} — data of event "${name}" does not match the declared schema: ${parsed.error.message}; data: ${truncateBody(event.data)}`,
    )
  }

  return {
    ...(event.id !== undefined && { id: event.id }),
    ...(event.retry !== undefined && { retry: event.retry }),
    event: name,
    data: parsed.data,
  } as ApiSSEEvent<Contract>
}

/** Media type an SSE response must carry. */
export const SSE_CONTENT_TYPE = 'text/event-stream'

/** Strip `; charset=…` style parameters from a media type. */
export function mediaTypeOf(contentType: string | undefined): string | undefined {
  return contentType?.split(';')[0]?.trim().toLowerCase()
}

/**
 * Reject a response that is not an event stream, naming the reader that asked for one.
 *
 * Shared by both read paths so an endpoint answering with a JSON error (a 401 before
 * `sse.start()`, say) fails with its status and body on either — rather than as zero events,
 * which reads as a timeout on the HTTP path and an empty array on the inject one.
 *
 * @param reader - Name of the calling reader (`events()`, `stream()`, …), used as the error prefix
 * @param body - Response body, when the caller can produce it without consuming a live stream
 */
export function assertSSEResponse(
  statusCode: number,
  contentType: string | undefined,
  reader: string,
  body?: string,
): void {
  const mediaType = mediaTypeOf(contentType)
  if (mediaType === SSE_CONTENT_TYPE) {
    return
  }
  const bodySuffix = body === undefined || body === '' ? '' : ` Body: ${truncateBody(body)}`
  throw new Error(
    `${reader} — response is not an SSE stream (status ${statusCode}, content-type ${mediaType ?? 'absent'}); use bodyForStatus(${statusCode}) for declared error responses.${bodySuffix}`,
  )
}
