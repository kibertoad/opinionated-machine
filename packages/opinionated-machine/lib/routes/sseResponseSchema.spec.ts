import { jsonSchemaTransform } from 'fastify-type-provider-zod'
import { describe, expect, it } from 'vitest'
import { z } from 'zod/v4'
import { buildSseEventSchema, buildSseResponseSchemas } from './sseResponseSchema.ts'

type ContentResponse = { content: Record<string, { schema: z.ZodTypeAny }> }

function statusSchema(response: Record<string, unknown>, statusCode: number): z.ZodTypeAny {
  return response[statusCode] as z.ZodTypeAny
}

describe('buildSseEventSchema', () => {
  it('describes a single event as one envelope object', () => {
    const schema = buildSseEventSchema({ message: z.object({ text: z.string() }) })

    expect(schema?.parse({ id: '1', event: 'message', data: { text: 'hi' }, retry: 3000 })).toEqual(
      { id: '1', event: 'message', data: { text: 'hi' }, retry: 3000 },
    )
  })

  it('leaves id and retry optional', () => {
    const schema = buildSseEventSchema({ message: z.object({ text: z.string() }) })

    expect(schema?.parse({ event: 'message', data: { text: 'hi' } })).toEqual({
      event: 'message',
      data: { text: 'hi' },
    })
  })

  it('discriminates the data payload by event name', () => {
    const schema = buildSseEventSchema({
      chunk: z.object({ delta: z.string() }),
      done: z.object({ total: z.number() }),
    })

    expect(schema?.parse({ event: 'chunk', data: { delta: 'a' } })).toEqual({
      event: 'chunk',
      data: { delta: 'a' },
    })
    expect(schema?.parse({ event: 'done', data: { total: 1 } })).toEqual({
      event: 'done',
      data: { total: 1 },
    })
    // Payload of the wrong event does not satisfy the union
    expect(() => schema?.parse({ event: 'chunk', data: { total: 1 } })).toThrow()
    expect(() => schema?.parse({ event: 'unknown', data: {} })).toThrow()
  })

  it('returns undefined when the contract declares no events', () => {
    expect(buildSseEventSchema({})).toBeUndefined()
  })
})

describe('buildSseResponseSchemas', () => {
  const events = { message: z.object({ text: z.string() }) }

  it('describes the event stream under 200 text/event-stream', () => {
    const response = buildSseResponseSchemas(events, undefined)

    const ok = response[200] as ContentResponse
    expect(Object.keys(ok.content)).toEqual(['text/event-stream'])
    expect(
      ok.content['text/event-stream']?.schema.parse({ event: 'message', data: { text: 'x' } }),
    ).toEqual({ event: 'message', data: { text: 'x' } })
  })

  it('accepts the declared body at each error status', () => {
    const notFound = z.object({ error: z.string() })
    const unprocessable = z.object({ details: z.string() })

    const response = buildSseResponseSchemas(events, { 404: notFound, 422: unprocessable })

    expect(statusSchema(response, 404).parse({ error: 'Not found' })).toEqual({
      error: 'Not found',
    })
    expect(statusSchema(response, 422).parse({ details: 'nope' })).toEqual({ details: 'nope' })
  })

  it('also accepts a framework error envelope at each error status', () => {
    // Fastify serializes its own error bodies (FST_ERR_VALIDATION and anything an
    // application-level error handler returns) against the same schema, so a status that only
    // accepted the handler's shape would turn a declared 400 into a 500.
    const response = buildSseResponseSchemas(events, {
      400: z.object({ error: z.string(), details: z.array(z.string()) }),
    })

    expect(
      statusSchema(response, 400).parse({
        statusCode: 400,
        error: 'Bad Request',
        code: 'FST_ERR_VALIDATION',
        message: 'querystring/q Invalid input',
      }),
    ).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      code: 'FST_ERR_VALIDATION',
      message: 'querystring/q Invalid input',
    })
  })

  it('prefers the declared body when it also matches the framework envelope', () => {
    const response = buildSseResponseSchemas(events, {
      404: z.object({ statusCode: z.number(), message: z.string() }),
    })

    // Undeclared keys are still dropped rather than carried through the envelope branch
    expect(
      statusSchema(response, 404).parse({ statusCode: 404, message: 'gone', internal: 'x' }),
    ).toEqual({ statusCode: 404, message: 'gone' })
  })

  it('keeps extra fields of a custom error handler body', () => {
    const response = buildSseResponseSchemas(events, { 500: z.object({ reason: z.string() }) })

    expect(
      statusSchema(response, 500).parse({ statusCode: 500, message: 'boom', traceId: 'abc' }),
    ).toEqual({ statusCode: 500, message: 'boom', traceId: 'abc' })
  })

  it('accepts both success shapes at a declared non-200 2xx status', () => {
    // handleSyncMode validates any 2xx against successResponseBodySchema, while
    // processSSEHandlerResult validates sse.respond(201, ...) against the declared 201 schema.
    const syncBody = z.object({ result: z.string() })
    const created = z.object({ createdId: z.string() })

    const response = buildSseResponseSchemas(events, { 201: created }, syncBody)

    expect(statusSchema(response, 201).parse({ result: 'made' })).toEqual({ result: 'made' })
    expect(statusSchema(response, 201).parse({ createdId: 'id-1' })).toEqual({ createdId: 'id-1' })
  })

  it('keeps the event stream when the contract also declares a 200 body', () => {
    const okBody = z.object({ accepted: z.boolean() })

    const response = buildSseResponseSchemas(events, { 200: okBody })

    const ok = response[200] as ContentResponse
    expect(Object.keys(ok.content).sort()).toEqual(['application/json', 'text/event-stream'])
    expect(ok.content['application/json']?.schema).toBe(okBody)
  })

  it('describes both branches of a dual-mode 200', () => {
    const syncBody = z.object({ result: z.string() })

    const response = buildSseResponseSchemas(events, undefined, syncBody)

    const ok = response[200] as ContentResponse
    expect(Object.keys(ok.content).sort()).toEqual(['application/json', 'text/event-stream'])
    expect(ok.content['application/json']?.schema).toBe(syncBody)
  })

  it('accepts both success shapes when a dual-mode contract also declares a 200 body', () => {
    const syncBody = z.object({ result: z.string() })
    const declaredOk = z.object({ other: z.string() })

    const response = buildSseResponseSchemas(events, { 200: declaredOk }, syncBody)

    const jsonSchema = (response[200] as ContentResponse).content['application/json']?.schema
    expect(jsonSchema?.parse({ result: 'ok' })).toEqual({ result: 'ok' })
    expect(jsonSchema?.parse({ other: 'x' })).toEqual({ other: 'x' })
  })

  it('omits 200 entirely when there is nothing to describe', () => {
    expect(buildSseResponseSchemas({}, undefined)).toEqual({})
  })

  it('still describes error statuses when the contract declares no events', () => {
    const notFound = z.object({ error: z.string() })

    const response = buildSseResponseSchemas({}, { 404: notFound })

    expect(response[200]).toBeUndefined()
    expect(statusSchema(response, 404).parse({ error: 'Not found' })).toEqual({
      error: 'Not found',
    })
  })
})

describe('OpenAPI output', () => {
  // fastify-type-provider-zod turns `schema.response` into the spec @fastify/swagger serves,
  // so this is the check that the contract's shapes actually reach the generated document.
  type JsonSchemaNode = {
    type?: string
    const?: unknown
    required?: string[]
    oneOf?: JsonSchemaNode[]
    anyOf?: JsonSchemaNode[]
    properties?: Record<string, JsonSchemaNode>
    content?: Record<string, { schema: JsonSchemaNode }>
  }

  function transform(response: Record<string, unknown>): Record<string, JsonSchemaNode> {
    const document = {
      schema: { response },
      url: '/api/stream',
      // Minimal stand-in for the document @fastify/swagger passes in; the transform only
      // reads `schema`, `url`, and the OpenAPI version.
      openapiObject: { openapi: '3.1.0' },
    } as unknown as Parameters<typeof jsonSchemaTransform>[0]

    const { schema } = jsonSchemaTransform(document)
    return (schema as { response: Record<string, JsonSchemaNode> }).response
  }

  function mediaSchema(
    response: Record<string, JsonSchemaNode>,
    statusCode: number,
    mediaType: string,
  ): JsonSchemaNode {
    const schema = response[statusCode]?.content?.[mediaType]?.schema
    if (!schema) {
      throw new Error(`No rendered schema for ${statusCode} ${mediaType}`)
    }
    return schema
  }

  it('renders the event stream as one envelope per event under text/event-stream', () => {
    const response = transform(
      buildSseResponseSchemas(
        {
          chunk: z.object({ delta: z.string() }),
          done: z.object({ total: z.number() }),
        },
        undefined,
      ),
    )

    const eventSchema = mediaSchema(response, 200, 'text/event-stream')
    expect(eventSchema.oneOf).toHaveLength(2)
    expect(eventSchema.oneOf?.[0]?.properties?.event).toEqual({ type: 'string', const: 'chunk' })
    expect(eventSchema.oneOf?.[0]?.properties?.data).toMatchObject({
      type: 'object',
      properties: { delta: { type: 'string' } },
    })
    expect(eventSchema.oneOf?.[1]?.properties?.event).toEqual({ type: 'string', const: 'done' })
  })

  it('renders the dual-mode sync body under application/json on the same status', () => {
    const response = transform(
      buildSseResponseSchemas(
        { message: z.object({ text: z.string() }) },
        undefined,
        z.object({ result: z.string() }),
      ),
    )

    expect(Object.keys(response['200']?.content ?? {}).sort()).toEqual([
      'application/json',
      'text/event-stream',
    ])
    expect(mediaSchema(response, 200, 'application/json')).toMatchObject({
      type: 'object',
      properties: { result: { type: 'string' } },
      required: ['result'],
    })
  })

  it('renders a declared error status with the framework envelope as an alternative', () => {
    const response = transform(
      buildSseResponseSchemas(
        { message: z.object({ text: z.string() }) },
        {
          404: z.object({ error: z.string(), resourceId: z.string() }),
        },
      ),
    )

    expect(response['404']?.anyOf).toHaveLength(2)
    expect(response['404']?.anyOf?.[0]).toMatchObject({
      type: 'object',
      required: ['error', 'resourceId'],
    })
    expect(response['404']?.anyOf?.[1]).toMatchObject({
      type: 'object',
      required: ['statusCode', 'message'],
    })
  })
})
