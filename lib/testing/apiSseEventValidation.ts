/**
 * Contract-aware SSE event validation, shared by the inject helpers (`injectApiSSE`) and the
 * real-HTTP ones (`connectApiSSE`, `SSEHttpClient.apiEvents`) so both paths produce the same
 * discriminated union, validated against the same schemas and reporting the same errors.
 *
 * @internal
 */

import type { SSEEventSchemas } from '@lokalise/api-contracts'
import { type ApiContract, getSseSchemaByEventName } from '@lokalise/api-contracts'
import type { ParsedSSEEvent } from '../sse/sseParser.ts'
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
