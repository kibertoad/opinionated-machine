import { defineApiContract, sseResponse } from '@lokalise/api-contracts'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod/v4'
import { defineContractEvent, defineContractEvents } from './defineContractEvent.js'
import type { SSEEventDefinition } from './defineEvent.js'

const itemCreatedSchema = z.object({ id: z.string(), name: z.string() })
const itemDeletedSchema = z.object({ id: z.string() })

const streamContract = defineApiContract({
  method: 'get',
  visibility: 'internal',
  summary: 'Stream item changes',
  pathResolver: () => '/api/items/stream',
  responsesByStatusCode: {
    200: sseResponse({
      'item.created': itemCreatedSchema,
      'item.deleted': itemDeletedSchema,
    }),
  },
})

const jsonContract = defineApiContract({
  method: 'get',
  visibility: 'internal',
  summary: 'List items',
  pathResolver: () => '/api/items',
  responsesByStatusCode: {
    200: z.object({ items: z.array(itemCreatedSchema) }),
  },
})

describe('defineContractEvent', () => {
  it('defines an event with the schema the contract declares for it', () => {
    const event = defineContractEvent(streamContract, 'item.created')

    expect(event).toEqual({ event: 'item.created', schema: itemCreatedSchema })
    expectTypeOf(event).toEqualTypeOf<
      SSEEventDefinition<'item.created', typeof itemCreatedSchema>
    >()
  })

  it('throws for an event the contract does not declare', () => {
    // @ts-expect-error -- only the contract's own event names type check
    expect(() => defineContractEvent(streamContract, 'item.updated')).toThrow(
      'Contract declares no SSE event named "item.updated"',
    )
  })
})

describe('defineContractEvents', () => {
  it('defines every event the contract declares, keyed by event name', () => {
    const events = defineContractEvents(streamContract)

    expect(events).toEqual({
      'item.created': { event: 'item.created', schema: itemCreatedSchema },
      'item.deleted': { event: 'item.deleted', schema: itemDeletedSchema },
    })
    expectTypeOf(events['item.created']).toEqualTypeOf<
      SSEEventDefinition<'item.created', typeof itemCreatedSchema>
    >()
    expectTypeOf(events['item.deleted']).toEqualTypeOf<
      SSEEventDefinition<'item.deleted', typeof itemDeletedSchema>
    >()
    expectTypeOf(events).toHaveProperty('item.created')
    expectTypeOf(events).not.toHaveProperty('item.updated')
  })

  it('throws for a contract without an SSE response', () => {
    expect(() => defineContractEvents(jsonContract)).toThrow('Contract declares no SSE response')
  })
})
