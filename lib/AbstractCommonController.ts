import type { z } from 'zod'

export type OptionalZodSchema = z.Schema | undefined
export type InferredOptionalSchema<Schema> = Schema extends z.Schema ? z.infer<Schema> : never
