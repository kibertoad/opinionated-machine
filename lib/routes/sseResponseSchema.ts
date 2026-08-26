import type { HttpStatusCode, SSEEventSchemas } from '@lokalise/api-contracts'
import { z } from 'zod'

/**
 * Fastify response schemas keyed by status code. Values are either a bare Zod schema (JSON)
 * or Fastify's per-media-type form (`{ content: { '<mediaType>': { schema } } }`).
 */
export type ResponseSchemasByStatusCode = Record<string, unknown>

/**
 * Describe an SSE stream as the union of its event envelopes, following the OpenAPI 3.x
 * convention for `text/event-stream`: one object schema per event type (`{ id?, event, data,
 * retry? }`), discriminated by the `event` name, so the contract's event payloads show up in
 * the generated spec.
 *
 * Mirrors what `@lokalise/fastify-api-contracts` produces for an `sseBody()` response, so
 * legacy SSE / dual-mode contracts and `ApiContract` ones document the same way.
 *
 * @returns The event envelope schema, or `undefined` when the contract declares no events
 */
export function buildSseEventSchema(
  serverSentEventSchemas: SSEEventSchemas,
): z.ZodTypeAny | undefined {
  const eventSchemas = Object.entries(serverSentEventSchemas).map(([eventName, dataSchema]) =>
    z.object({
      id: z.string().optional(),
      event: z.literal(eventName),
      data: dataSchema,
      retry: z.int().optional(),
    }),
  )

  const [firstEventSchema, ...restEventSchemas] = eventSchemas
  if (!firstEventSchema) {
    return undefined
  }

  return restEventSchemas.length === 0 ? firstEventSchema : z.union(eventSchemas)
}

/**
 * Build the `schema.response` map for an SSE or dual-mode route from its contract.
 *
 * The 200 entry uses Fastify's per-media-type form so a single status can describe both the
 * event stream and the JSON body: `text/event-stream` carries the event envelopes, and
 * `application/json` carries the sync body (dual-mode) or whatever the contract declares for
 * 200 (an SSE route that answers `sse.respond(200, ...)` before streaming starts). Remaining
 * status codes are passed through as bare Zod schemas.
 *
 * Populating this drives both the OpenAPI spec and Fastify's serializer, so a status code the
 * contract declares is now serialized against its schema instead of plain `JSON.stringify`.
 *
 * @param serverSentEventSchemas - Contract's event name to payload schema map
 * @param responseBodySchemasByStatusCode - Contract's per-status response schemas, if any
 * @param syncSuccessSchema - Dual-mode sync 200 body schema; omit for SSE-only contracts
 */
export function buildSseResponseSchemas(
  serverSentEventSchemas: SSEEventSchemas,
  responseBodySchemasByStatusCode: Partial<Record<HttpStatusCode, z.ZodTypeAny>> | undefined,
  syncSuccessSchema?: z.ZodTypeAny,
): ResponseSchemasByStatusCode {
  const { 200: declaredOkSchema, ...otherStatusSchemas } = responseBodySchemasByStatusCode ?? {}
  const jsonOkSchema = syncSuccessSchema ?? declaredOkSchema
  const eventSchema = buildSseEventSchema(serverSentEventSchemas)

  const okContent: Record<string, { schema: z.ZodTypeAny }> = {
    ...(eventSchema && { 'text/event-stream': { schema: eventSchema } }),
    ...(jsonOkSchema && { 'application/json': { schema: jsonOkSchema } }),
  }

  return {
    ...(Object.keys(okContent).length > 0 && { 200: { content: okContent } }),
    ...otherStatusSchemas,
  }
}
