import { describe, expect, it } from 'vitest'
import { z } from 'zod/v4'
import { buildSseEventSchema, buildSseResponseSchemas } from './sseResponseSchema.ts'

type ContentResponse = { content: Record<string, { schema: z.ZodTypeAny }> }

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

  it('passes error status schemas through unchanged', () => {
    const notFound = z.object({ error: z.string() })
    const unprocessable = z.object({ details: z.string() })

    const response = buildSseResponseSchemas(events, { 404: notFound, 422: unprocessable })

    expect(response[404]).toBe(notFound)
    expect(response[422]).toBe(unprocessable)
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

  it('prefers the sync success schema over a declared 200 body', () => {
    const syncBody = z.object({ result: z.string() })
    const declaredOk = z.object({ other: z.string() })

    const response = buildSseResponseSchemas(events, { 200: declaredOk }, syncBody)

    const ok = response[200] as ContentResponse
    expect(ok.content['application/json']?.schema).toBe(syncBody)
  })

  it('omits 200 entirely when there is nothing to describe', () => {
    expect(buildSseResponseSchemas({}, undefined)).toEqual({})
  })

  it('still describes error statuses when the contract declares no events', () => {
    const notFound = z.object({ error: z.string() })

    const response = buildSseResponseSchemas({}, { 404: notFound })

    expect(response[200]).toBeUndefined()
    expect(response[404]).toBe(notFound)
  })
})
