import type { FastifyRequest } from 'fastify'
import type { z } from 'zod'

type InferredOptionalSchema<Schema> = Schema extends z.Schema ? z.infer<Schema> : never

/**
 * Infer fastify request type from a contract
 */
export type InferRequestFromContract<
  Contract extends {
    requestHeaderSchema?: z.Schema
    requestPathParamsSchema?: z.Schema
    requestQuerySchema?: z.Schema
    successResponseBodySchema: z.Schema
  },
> = FastifyRequest<{
  Body: never
  Headers: InferredOptionalSchema<Contract['requestHeaderSchema']>
  Params: InferredOptionalSchema<Contract['requestPathParamsSchema']>
  Querystring: InferredOptionalSchema<Contract['requestQuerySchema']>
  Reply: InferredOptionalSchema<Contract['successResponseBodySchema']>
}>

// I am not sure if I understand the purpose of this, isn't it what we have with fastify api contracts?