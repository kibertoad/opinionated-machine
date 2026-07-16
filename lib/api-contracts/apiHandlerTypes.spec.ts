import {
  anyOfResponses,
  defineApiContract,
  type SSEEventSchemas,
  sseBody,
  sseResponse,
} from '@lokalise/api-contracts'
import { describe, expectTypeOf, it } from 'vitest'
import { z } from 'zod/v4'
import type { SSEContext } from '../routes/fastifyRouteTypes.ts'
import type { ApiSseHandler, EnsureSseEventSchemas } from './apiHandlerTypes.ts'

// ============================================================================
// Shared fixtures
// ============================================================================

const eventSchemas = {
  update: z.object({ value: z.number() }),
  done: z.object({ total: z.number() }),
}
type EventSchemas = typeof eventSchemas

const userSchema = z.object({ id: z.string(), name: z.string() })

// ============================================================================
// EnsureSseEventSchemas — the fallback helper introduced for the SSEContext constraint
// ============================================================================

describe('EnsureSseEventSchemas', () => {
  it('passes a valid schema map through unchanged', () => {
    expectTypeOf<EnsureSseEventSchemas<EventSchemas>>().toEqualTypeOf<EventSchemas>()
  })

  it('preserves an empty schema map', () => {
    expectTypeOf<EnsureSseEventSchemas<Record<string, never>>>().toEqualTypeOf<
      Record<string, never>
    >()
  })

  it('falls back to SSEEventSchemas when the inferred type is unknown', () => {
    expectTypeOf<EnsureSseEventSchemas<unknown>>().toEqualTypeOf<SSEEventSchemas>()
  })

  it('falls back to SSEEventSchemas for a non-schema type', () => {
    expectTypeOf<EnsureSseEventSchemas<string>>().toEqualTypeOf<SSEEventSchemas>()
    expectTypeOf<EnsureSseEventSchemas<{ notASchema: number }>>().toEqualTypeOf<SSEEventSchemas>()
  })
})

// ============================================================================
// ApiSseHandler — the `sse` param resolves to a correctly-typed SSEContext
// ============================================================================

describe('ApiSseHandler — SSEContext inference', () => {
  it('extracts event schemas from a legacy sseResponse entry', () => {
    const contract = defineApiContract({
      method: 'get',
      summary: 'Contract',
      pathResolver: () => '/stream',
      responsesByStatusCode: { 200: sseResponse(eventSchemas) },
    })
    expectTypeOf<Parameters<ApiSseHandler<typeof contract>>[1]>().toEqualTypeOf<
      SSEContext<EventSchemas>
    >()
  })

  it('extracts event schemas from a content-map sseBody entry', () => {
    const contract = defineApiContract({
      method: 'get',
      summary: 'Contract',
      pathResolver: () => '/content-stream',
      responsesByStatusCode: {
        200: { content: { 'text/event-stream': sseBody(eventSchemas) } },
      },
    })
    expectTypeOf<Parameters<ApiSseHandler<typeof contract>>[1]>().toEqualTypeOf<
      SSEContext<EventSchemas>
    >()
  })

  it('extracts event schemas from a content-map entry that also carries JSON (dual)', () => {
    const contract = defineApiContract({
      method: 'post',
      summary: 'Contract',
      pathResolver: () => '/content-chat',
      requestBodySchema: z.object({ message: z.string() }),
      responsesByStatusCode: {
        200: {
          content: { 'application/json': userSchema, 'text/event-stream': sseBody(eventSchemas) },
        },
      },
    })
    expectTypeOf<Parameters<ApiSseHandler<typeof contract>>[1]>().toEqualTypeOf<
      SSEContext<EventSchemas>
    >()
  })

  it('extracts event schemas nested inside anyOfResponses', () => {
    const contract = defineApiContract({
      method: 'post',
      summary: 'Contract',
      pathResolver: () => '/mixed',
      requestBodySchema: z.object({ message: z.string() }),
      responsesByStatusCode: {
        200: anyOfResponses([userSchema, sseResponse(eventSchemas)]),
      },
    })
    expectTypeOf<Parameters<ApiSseHandler<typeof contract>>[1]>().toEqualTypeOf<
      SSEContext<EventSchemas>
    >()
  })

  it('gives the handler a fully typed session sender', () => {
    const contract = defineApiContract({
      method: 'get',
      summary: 'Contract',
      pathResolver: () => '/stream',
      responsesByStatusCode: { 200: sseResponse(eventSchemas) },
    })

    const handler: ApiSseHandler<typeof contract> = (_request, sse) => {
      const session = sse.start('autoClose')
      // Event names and payloads are inferred from the contract's SSE schemas.
      void session.send('update', { value: 1 })
      void session.send('done', { total: 2 })
      // @ts-expect-error - 'nope' is not a declared event name
      void session.send('nope', { value: 1 })
    }
    expectTypeOf(handler).toBeFunction()
  })
})
