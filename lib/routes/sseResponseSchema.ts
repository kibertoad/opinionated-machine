import type { HttpStatusCode, SSEEventSchemas } from '@lokalise/api-contracts'
import { z } from 'zod'

/**
 * Fastify response schemas keyed by status code. Values are either a bare Zod schema (JSON)
 * or Fastify's per-media-type form (`{ content: { '<mediaType>': { schema } } }`).
 */
export type ResponseSchemasByStatusCode = Record<string, unknown>

/**
 * Shape of the error bodies Fastify and the SSE route builders emit themselves, rather than
 * the handler: `FST_ERR_VALIDATION` when a request fails schema validation, whatever an
 * application-level `setErrorHandler` returns, and the `{ statusCode, error, message }`
 * envelope the builders send when a handler throws before streaming starts.
 *
 * A declared status schema is unioned with this so those bodies stay serializable. Without it
 * Fastify serializes them against the handler's schema, fails, and turns a declared 400 or 404
 * into a 500 `FST_ERR_FAILED_ERROR_SERIALIZATION`. Loose so a custom error handler's extra
 * fields survive; `statusCode` and `message` are what keeps it from matching handler bodies.
 * `error` and `code` are listed even though loose mode would carry them anyway, because
 * Fastify defines them as non-enumerable properties that key enumeration would skip.
 */
const frameworkErrorSchema = z.looseObject({
  statusCode: z.number(),
  message: z.string(),
  error: z.string().optional(),
  code: z.string().optional(),
})

/**
 * Combine alternative body schemas for one status.
 *
 * A single schema is returned as-is rather than wrapped, so a status with only one possible
 * body does not pick up a pointless `anyOf` in the generated spec.
 *
 * @returns The combined schema, or `undefined` when there is nothing to describe
 */
function unionOf(schemas: z.ZodTypeAny[]): z.ZodTypeAny | undefined {
  const [first, ...rest] = schemas
  if (!first) {
    return undefined
  }

  return rest.length === 0 ? first : z.union(schemas)
}

/**
 * Describe an SSE stream as the union of its event envelopes, following the OpenAPI 3.x
 * convention for `text/event-stream`: one object schema per event type (`{ id?, event, data,
 * retry? }`), discriminated on the `event` name so the contract's event payloads show up in
 * the generated spec as a `oneOf` of envelopes with a `const` event name.
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

  return restEventSchemas.length === 0
    ? firstEventSchema
    : z.discriminatedUnion('event', [firstEventSchema, ...restEventSchemas])
}

/**
 * Build the JSON schema for one declared status code.
 *
 * A status's schema has to accept every body the runtime can put out at that status,
 * because Fastify serializes against it and rejects anything that does not match:
 *
 * - 2xx on a dual-mode contract: `handleSyncMode` validates the sync body against
 *   `successResponseBodySchema` while `processSSEHandlerResult` validates `sse.respond()`
 *   against the contract's schema for that status, so both shapes are possible.
 * - Non-2xx: the handler's declared body, or a framework error envelope.
 */
function buildStatusSchema(
  statusCode: number,
  declaredSchema: z.ZodTypeAny | undefined,
  syncSuccessSchema: z.ZodTypeAny | undefined,
): z.ZodTypeAny | undefined {
  const isSuccessStatus = statusCode >= 200 && statusCode < 300
  if (isSuccessStatus) {
    return unionOf([syncSuccessSchema, declaredSchema].filter((schema) => schema !== undefined))
  }

  return declaredSchema && z.union([declaredSchema, frameworkErrorSchema])
}

/**
 * Build the `schema.response` map for an SSE or dual-mode route from its contract.
 *
 * The 200 entry uses Fastify's per-media-type form so a single status can describe both the
 * event stream and the JSON body: `text/event-stream` carries the event envelopes, and
 * `application/json` carries the sync body (dual-mode), the body the contract declares for
 * 200 (an SSE route that answers `sse.respond(200, ...)` before streaming starts), or both.
 *
 * Populating this drives both the OpenAPI spec and Fastify's serializer, so a status code the
 * contract declares is now serialized against its schema instead of plain `JSON.stringify`.
 *
 * @param serverSentEventSchemas - Contract's event name to payload schema map
 * @param responseBodySchemasByStatusCode - Contract's per-status response schemas, if any
 * @param syncSuccessSchema - Dual-mode sync 2xx body schema; omit for SSE-only contracts
 */
export function buildSseResponseSchemas(
  serverSentEventSchemas: SSEEventSchemas,
  responseBodySchemasByStatusCode: Partial<Record<HttpStatusCode, z.ZodTypeAny>> | undefined,
  syncSuccessSchema?: z.ZodTypeAny,
): ResponseSchemasByStatusCode {
  const { 200: declaredOkSchema, ...otherStatusSchemas } = responseBodySchemasByStatusCode ?? {}
  const jsonOkSchema = buildStatusSchema(200, declaredOkSchema, syncSuccessSchema)
  const eventSchema = buildSseEventSchema(serverSentEventSchemas)

  const okContent: Record<string, { schema: z.ZodTypeAny }> = {
    ...(eventSchema && { 'text/event-stream': { schema: eventSchema } }),
    ...(jsonOkSchema && { 'application/json': { schema: jsonOkSchema } }),
  }

  const responseSchemas: ResponseSchemasByStatusCode = {}
  if (Object.keys(okContent).length > 0) {
    responseSchemas[200] = { content: okContent }
  }

  for (const [statusCode, declaredSchema] of Object.entries(otherStatusSchemas)) {
    const schema = buildStatusSchema(Number(statusCode), declaredSchema, syncSuccessSchema)
    if (schema) {
      responseSchemas[statusCode] = schema
    }
  }

  return responseSchemas
}
