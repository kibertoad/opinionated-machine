import { type ApiContract, isContentResponseEntry, isSseBody } from '@lokalise/api-contracts'
import type { z } from 'zod'
import type {
  ApiSSEEventSchemas,
  SseEventNamesOf,
  SseSchemaForEventName,
} from './contractSseTypes.js'
import { defineEvent, type SSEEventDefinition } from './defineEvent.js'

type ContractEventName<Contract extends ApiContract> = SseEventNamesOf<ApiSSEEventSchemas<Contract>>

type ContractEventDefinition<
  Contract extends ApiContract,
  Name extends ContractEventName<Contract>,
> = SSEEventDefinition<
  Name,
  SseSchemaForEventName<ApiSSEEventSchemas<Contract>, Name> extends infer Schema extends z.ZodType
    ? Schema
    : never
>

type ContractEvents<Contract extends ApiContract> = {
  readonly [Name in ContractEventName<Contract>]: ContractEventDefinition<Contract, Name>
}

/** Every SSE event-schema map a contract declares, across all statuses and media types. */
const sseSchemaMapsOf = (contract: ApiContract): Record<string, z.ZodType>[] =>
  Object.values(contract.responsesByStatusCode).flatMap((entry) =>
    entry && isContentResponseEntry(entry)
      ? Object.values(entry.content ?? {})
          .filter(isSseBody)
          .map((descriptor) => descriptor.schemaByEventName)
      : [],
  )

/**
 * The SSE event schemas a contract declares, merged across every status like
 * `getSseSchemaByEventName`, or `null` when it declares none.
 *
 * Unlike that merge, where the last status silently wins, an event that two statuses declare
 * with different schemas throws: a producer could not know which schema its payload is
 * validated against.
 */
const getContractEventSchemas = (contract: ApiContract): Record<string, z.ZodType> | null => {
  const schemaByEventName: Record<string, z.ZodType> = {}
  for (const schemaMap of sseSchemaMapsOf(contract)) {
    for (const [name, schema] of Object.entries(schemaMap)) {
      if (Object.hasOwn(schemaByEventName, name) && schemaByEventName[name] !== schema) {
        throw new Error(`Contract declares SSE event "${name}" with different schemas`)
      }
      schemaByEventName[name] = schema
    }
  }

  return Object.keys(schemaByEventName).length > 0 ? schemaByEventName : null
}

/**
 * {@link defineEvent} for an event its contract already declares: the name is constrained to
 * the contract's own event names and the schema is read off the contract, so the event a room
 * publishes cannot drift from the contract its stream is served under.
 *
 * @throws {Error} if the contract declares no SSE response, no SSE event with that name, or an
 * event with different schemas on different statuses.
 */
export const defineContractEvent = <
  const Contract extends ApiContract,
  Name extends ContractEventName<Contract>,
>(
  contract: Contract,
  name: Name,
): ContractEventDefinition<Contract, Name> => {
  const schemaByEventName = getContractEventSchemas(contract)
  if (!schemaByEventName) throw new Error('Contract declares no SSE response')

  const schema = Object.hasOwn(schemaByEventName, name) ? schemaByEventName[name] : undefined
  if (!schema) throw new Error(`Contract declares no SSE event named "${name}"`)

  return defineEvent(name, schema) as ContractEventDefinition<Contract, Name>
}

/**
 * {@link defineContractEvent} for every SSE event a contract declares, keyed by event name.
 * An event added to the contract is defined without touching the call site.
 *
 * @throws {Error} if the contract declares no SSE response, or declares an event with different
 * schemas on different statuses.
 */
export const defineContractEvents = <const Contract extends ApiContract>(
  contract: Contract,
): ContractEvents<Contract> => {
  const schemaByEventName = getContractEventSchemas(contract)
  if (!schemaByEventName) {
    throw new Error('Contract declares no SSE response')
  }

  return Object.fromEntries(
    Object.entries(schemaByEventName).map(([name, schema]) => [name, defineEvent(name, schema)]),
  ) as ContractEvents<Contract>
}
