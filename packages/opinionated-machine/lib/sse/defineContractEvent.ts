import {
  type ApiContract,
  getSseSchemaByEventName,
  type InferSseSuccessResponses,
} from '@lokalise/api-contracts'
import type { z } from 'zod'
import { defineEvent, type SSEEventDefinition } from './defineEvent.js'

type ContractEventSchemas<Contract extends ApiContract> = InferSseSuccessResponses<
  Contract['responsesByStatusCode']
>

type ContractEventName<Contract extends ApiContract> = keyof ContractEventSchemas<Contract> & string

type ContractEventDefinition<
  Contract extends ApiContract,
  Name extends ContractEventName<Contract>,
> = SSEEventDefinition<
  Name,
  ContractEventSchemas<Contract>[Name] extends infer Schema extends z.ZodType ? Schema : never
>

/**
 * {@link defineEvent} for an event its contract already declares: the name is constrained to
 * the contract's own event names and the schema is read off the contract, so the event a room
 * publishes cannot drift from the contract its stream is served under.
 *
 * @throws {Error} if the contract declares no SSE event with that name.
 */
export function defineContractEvent<
  const Contract extends ApiContract,
  Name extends ContractEventName<Contract>,
>(contract: Contract, name: Name): ContractEventDefinition<Contract, Name> {
  const schema = getSseSchemaByEventName(contract)?.[name]
  if (!schema) {
    throw new Error(`Contract declares no SSE event named "${name}"`)
  }

  return defineEvent(name, schema) as ContractEventDefinition<Contract, Name>
}

/**
 * {@link defineContractEvent} for every SSE event a contract declares, keyed by event name.
 * An event added to the contract is defined without touching the call site.
 *
 * @throws {Error} if the contract declares no SSE response.
 */
export function defineContractEvents<const Contract extends ApiContract>(
  contract: Contract,
): { readonly [Name in ContractEventName<Contract>]: ContractEventDefinition<Contract, Name> } {
  const schemaByEventName = getSseSchemaByEventName(contract)
  if (!schemaByEventName) {
    throw new Error('Contract declares no SSE response')
  }

  return Object.fromEntries(
    Object.entries(schemaByEventName).map(([name, schema]) => [name, defineEvent(name, schema)]),
  ) as { readonly [Name in ContractEventName<Contract>]: ContractEventDefinition<Contract, Name> }
}
