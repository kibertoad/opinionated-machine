import type { z } from 'zod'

export type SSEEventDefinition<Name extends string = string, T extends z.ZodType = z.ZodType> = {
  readonly event: Name
  readonly schema: T
}

export function defineEvent<Name extends string, T extends z.ZodType>(
  event: Name,
  schema: T,
): SSEEventDefinition<Name, T> {
  return { event, schema }
}
