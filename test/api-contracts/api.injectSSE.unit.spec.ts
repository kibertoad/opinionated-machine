import {
  blobBody,
  defineApiContract,
  type HttpStatusCode,
  sseBody,
  sseResponse,
} from '@lokalise/api-contracts'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod/v4'
import { bindApiBodyForStatus, bindApiEvents } from '../../lib/testing/apiSseInjectHelpers.ts'
import type {
  ApiDeclaredResponseBody,
  ApiDeclaredResponseStatus,
  ApiSSEEvent,
  InjectApiSSEResult,
} from '../../lib/testing/apiSseTestTypes.ts'
import type { SSEResponse } from '../../lib/testing/sseTestTypes.ts'

/**
 * Direct unit coverage for the `injectApiSSE` accessors. The failure branches
 * (invalid JSON, schema mismatch, non-JSON declared body, wildcard status keys)
 * are awkward to drive deterministically through a real server, so they are
 * exercised here against synthetic `closed` results.
 */

const resolved = (res: Partial<SSEResponse>): Promise<SSEResponse> =>
  Promise.resolve({ statusCode: 200, headers: {}, body: '', ...res })

const jsonResponse = (statusCode: number, body: unknown): Promise<SSEResponse> =>
  resolved({
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  })

const streamResponse = (body: string): Promise<SSEResponse> =>
  resolved({ statusCode: 200, headers: { 'content-type': 'text/event-stream' }, body })

/** The contract shape from the downstream report: SSE 200 plus documented error statuses. */
const lqaContract = defineApiContract({
  visibility: 'internal',
  method: 'post',
  summary: 'Perform LQA on a text segment',
  pathResolver: () => '/v1/content/actions/lqa-text-segment',
  requestBodySchema: z.object({ segment: z.string() }),
  responsesByStatusCode: {
    200: sseResponse({
      review: z.object({ score: z.number() }),
      error: z.object({ reason: z.string() }),
    }),
    400: z.union([z.object({ message: z.string() }), z.object({ errors: z.array(z.string()) })]),
    500: z.object({ error: z.string() }),
  },
})

/** Wildcard keys: a range entry and a catch-all, both carrying JSON bodies. */
const wildcardContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Wildcard responses',
  pathResolver: () => '/wildcard',
  responsesByStatusCode: {
    200: sseResponse({ tick: z.object({ n: z.number() }) }),
    404: z.object({ notFound: z.literal(true) }),
    '4xx': z.object({ clientError: z.string() }),
    default: z.object({ fallback: z.string() }),
  },
})

/** SSE declared on several statuses at once, each carrying a different event name. */
const multiStatusSseContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Multi-status stream',
  pathResolver: () => '/multi-status',
  responsesByStatusCode: {
    200: sseResponse({ tick: z.object({ n: z.number() }) }),
    202: sseResponse({ queued: z.object({ id: z.string() }) }),
    // Not a success status: the runtime merges its events too, so the types must as well.
    '4xx': sseResponse({ failure: z.object({ reason: z.string() }) }),
  },
})

/** One status, one content map, both a JSON body and a stream — the dual-mode shape. */
const dualModeContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Dual mode',
  pathResolver: () => '/dual',
  responsesByStatusCode: {
    200: {
      content: {
        'application/json': z.object({ summary: z.string() }),
        'text/event-stream': sseBody({ update: z.object({ value: z.number() }) }),
      },
    },
  },
})

/** A content map whose descriptors are all non-JSON media types. */
const multiContentContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Multi content',
  pathResolver: () => '/multi-content',
  responsesByStatusCode: {
    200: {
      content: {
        'application/json': z.object({ ok: z.boolean() }),
        'application/pdf': blobBody(),
      },
    },
  },
})

/** No SSE anywhere — `events()` has nothing to read. */
const jsonOnlyContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Json only',
  pathResolver: () => '/json',
  responsesByStatusCode: { 200: z.object({ ok: z.boolean() }) },
})

describe('bindApiBodyForStatus', () => {
  it('returns the parsed body on the happy path', async () => {
    const bodyForStatus = bindApiBodyForStatus(
      lqaContract,
      jsonResponse(400, { message: 'segment must not be empty' }),
    )

    await expect(bodyForStatus(400)).resolves.toEqual({ message: 'segment must not be empty' })
  })

  it('throws when the actual status does not match the expected one', async () => {
    const bodyForStatus = bindApiBodyForStatus(lqaContract, jsonResponse(500, { error: 'boom' }))

    await expect(bodyForStatus(400)).rejects.toThrow(/bodyForStatus\(400\) — actual status 500/)
  })

  it('throws when the contract declares no response for the matched status', async () => {
    const bodyForStatus = bindApiBodyForStatus(lqaContract, jsonResponse(503, {}))

    await expect(bodyForStatus(503 as never)).rejects.toThrow(
      /no response declared for status 503 in contract\.responsesByStatusCode/,
    )
  })

  it('throws when the declared response for the status is a stream, not a JSON body', async () => {
    const bodyForStatus = bindApiBodyForStatus(lqaContract, streamResponse('event: review\n\n'))

    await expect(bodyForStatus(200 as never)).rejects.toThrow(
      /the contract declares a 'sse' response for status 200, not a JSON body/,
    )
  })

  it('throws a contextual error when the body is not valid JSON', async () => {
    const bodyForStatus = bindApiBodyForStatus(
      lqaContract,
      resolved({ statusCode: 400, headers: { 'content-type': 'application/json' }, body: 'nope' }),
    )

    await expect(bodyForStatus(400)).rejects.toThrow(/body is not valid JSON/)
  })

  it('throws a contextual error when the body fails schema validation', async () => {
    const bodyForStatus = bindApiBodyForStatus(lqaContract, jsonResponse(400, { message: 42 }))

    await expect(bodyForStatus(400)).rejects.toThrow(/body does not match the declared schema/)
  })

  it('falls back to the declared kind when the response carries no content-type', async () => {
    const bodyForStatus = bindApiBodyForStatus(
      lqaContract,
      resolved({ statusCode: 500, body: JSON.stringify({ error: 'boom' }) }),
    )

    await expect(bodyForStatus(500)).resolves.toEqual({ error: 'boom' })
  })

  it('resolves a range key for statuses without an exact entry', async () => {
    const bodyForStatus = bindApiBodyForStatus(
      wildcardContract,
      jsonResponse(422, { clientError: 'unprocessable' }),
    )

    await expect(bodyForStatus(422)).resolves.toEqual({ clientError: 'unprocessable' })
  })

  it('prefers the exact entry over the range key', async () => {
    const bodyForStatus = bindApiBodyForStatus(
      wildcardContract,
      jsonResponse(404, {
        notFound: true,
      }),
    )

    await expect(bodyForStatus(404)).resolves.toEqual({ notFound: true })
  })

  it('falls back to the default key for statuses outside every declared range', async () => {
    const bodyForStatus = bindApiBodyForStatus(
      wildcardContract,
      jsonResponse(503, { fallback: 'unavailable' }),
    )

    await expect(bodyForStatus(503)).resolves.toEqual({ fallback: 'unavailable' })
  })

  it('names the offending content-type when no descriptor of the entry matches it', async () => {
    const bodyForStatus = bindApiBodyForStatus(
      multiContentContract,
      resolved({ statusCode: 200, headers: { 'content-type': 'text/plain' }, body: 'plain' }),
    )

    await expect(bodyForStatus(200)).rejects.toThrow(
      /the '200' entry of contract\.responsesByStatusCode declares no body for content-type 'text\/plain'/,
    )
  })

  it('rejects a dual-mode status, which always answers with the stream', async () => {
    const bodyForStatus = bindApiBodyForStatus(
      dualModeContract,
      streamResponse('event: update\ndata: {"value":1}\n\n'),
    )

    // @ts-expect-error — 200 declares a stream, so it carries no reachable JSON body here
    await expect(bodyForStatus(200)).rejects.toThrow(
      /declares a 'sse' response for status 200, not a JSON body — injectApiSSE requests/,
    )
  })

  it('excludes a dual-mode status from the callable statuses', () => {
    // The request forces `accept: text/event-stream`, so the JSON side is unreachable.
    expectTypeOf<ApiDeclaredResponseStatus<typeof dualModeContract>>().toEqualTypeOf<never>()
    // A plain multi-descriptor content map without a stream still exposes its JSON entry.
    expectTypeOf<ApiDeclaredResponseStatus<typeof multiContentContract>>().toEqualTypeOf<200>()
    expectTypeOf<ApiDeclaredResponseBody<typeof multiContentContract, 200>>().toEqualTypeOf<{
      ok: boolean
    }>()
  })

  it('types the body per status, including range and default keys', () => {
    type Body<Status extends HttpStatusCode> = ApiDeclaredResponseBody<
      typeof wildcardContract,
      Status
    >
    expectTypeOf<Body<404>>().toEqualTypeOf<{ notFound: true }>()
    expectTypeOf<Body<422>>().toEqualTypeOf<{ clientError: string }>()
    expectTypeOf<Body<503>>().toEqualTypeOf<{ fallback: string }>()
  })

  it('only accepts statuses the contract declares a JSON body for', () => {
    type IsDeclared<Status extends HttpStatusCode> =
      Status extends ApiDeclaredResponseStatus<typeof wildcardContract> ? true : false
    expectTypeOf<IsDeclared<404>>().toEqualTypeOf<true>()
    expectTypeOf<IsDeclared<422>>().toEqualTypeOf<true>()
    expectTypeOf<IsDeclared<503>>().toEqualTypeOf<true>()
    // The SSE-only success status carries no JSON body.
    expectTypeOf<IsDeclared<200>>().toEqualTypeOf<false>()
  })
})

describe('bindApiEvents', () => {
  it('parses and validates events against the contract schemas', async () => {
    const events = bindApiEvents(
      lqaContract,
      streamResponse(
        'id: 1\nevent: review\ndata: {"score":5}\n\nevent: error\ndata: {"reason":"nope"}\n\n',
      ),
    )

    await expect(events()).resolves.toEqual([
      { id: '1', event: 'review', data: { score: 5 } },
      { event: 'error', data: { reason: 'nope' } },
    ])
  })

  it('keeps the retry hint when the server sends one', async () => {
    const events = bindApiEvents(
      lqaContract,
      streamResponse('event: review\nretry: 3000\ndata: {"score":1}\n\n'),
    )

    await expect(events()).resolves.toEqual([{ retry: 3000, event: 'review', data: { score: 1 } }])
  })

  it('throws when an event name is not declared by the contract', async () => {
    const events = bindApiEvents(lqaContract, streamResponse('event: ghost\ndata: {}\n\n'))

    await expect(events()).rejects.toThrow(/declares no schema for event "ghost"/)
  })

  it('throws when an event payload is not valid JSON', async () => {
    const events = bindApiEvents(lqaContract, streamResponse('event: review\ndata: nope\n\n'))

    await expect(events()).rejects.toThrow(/data of event "review" is not valid JSON/)
  })

  it('throws when an event payload does not match its schema', async () => {
    const events = bindApiEvents(
      lqaContract,
      streamResponse('event: review\ndata: {"score":"high"}\n\n'),
    )

    await expect(events()).rejects.toThrow(
      /data of event "review" does not match the declared schema/,
    )
  })

  it('throws when the contract declares no SSE response', async () => {
    const events = bindApiEvents(jsonOnlyContract, streamResponse(''))

    await expect(events()).rejects.toThrow(/declares no SSE response/)
  })

  it('validates events declared on any status, not just the successful ones', async () => {
    const events = bindApiEvents(
      multiStatusSseContract,
      streamResponse(
        'event: tick\ndata: {"n":1}\n\nevent: queued\ndata: {"id":"a"}\n\nevent: failure\ndata: {"reason":"nope"}\n\n',
      ),
    )

    await expect(events()).resolves.toEqual([
      { event: 'tick', data: { n: 1 } },
      { event: 'queued', data: { id: 'a' } },
      { event: 'failure', data: { reason: 'nope' } },
    ])
  })

  it('types the merged events of every status the contract streams on', () => {
    type Event = ApiSSEEvent<typeof multiStatusSseContract>

    // `keyof` a union of maps would collapse to `never` here — the names have to be unioned.
    expectTypeOf<Event['event']>().toEqualTypeOf<'tick' | 'queued' | 'failure'>()
    expectTypeOf<Extract<Event, { event: 'queued' }>['data']>().toEqualTypeOf<{ id: string }>()
    expectTypeOf<Extract<Event, { event: 'failure' }>['data']>().toEqualTypeOf<{ reason: string }>()
  })

  it('is not callable for a contract that declares no SSE response', () => {
    expectTypeOf<InjectApiSSEResult<typeof jsonOnlyContract>['events']>().toEqualTypeOf<never>()
    expectTypeOf<InjectApiSSEResult<typeof multiStatusSseContract>['events']>().toBeCallableWith()
  })

  it('types events as a discriminated union on the event name', async () => {
    const events = await bindApiEvents(
      lqaContract,
      streamResponse('event: review\ndata: {"score":5}\n\n'),
    )()

    const event = events[0]!
    if (event.event === 'review') {
      expectTypeOf(event.data).toEqualTypeOf<{ score: number }>()
    } else {
      expectTypeOf(event.data).toEqualTypeOf<{ reason: string }>()
    }
  })
})
