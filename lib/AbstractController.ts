import { type RouteType, buildFastifyNoPayloadRoute } from '@lokalise/fastify-api-contracts'
import type { DeleteRouteDefinition } from '@lokalise/universal-ts-utils/dist/public/api-contracts/apiContracts'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { z } from 'zod'
import type { InferredOptionalSchema } from './AbstractCommonController.js'

export abstract class AbstractDeleteController<
  APIContract extends DeleteRouteDefinition<
    PathParams,
    SuccessResponseBodySchema,
    PathParamsSchema,
    RequestQuerySchema,
    RequestHeaderSchema,
    IsNonJSONResponseExpected,
    IsEmptyResponseExpected
  >,
  PathParams,
  SuccessResponseBodySchema extends z.Schema | undefined = undefined,
  PathParamsSchema extends z.Schema<PathParams> | undefined = undefined,
  RequestQuerySchema extends z.Schema | undefined = undefined,
  RequestHeaderSchema extends z.Schema | undefined = undefined,
  IsNonJSONResponseExpected extends boolean = false,
  IsEmptyResponseExpected extends boolean = true,
> {
  private readonly apiContract: APIContract
  private route: RouteType

  constructor(apiContract: APIContract) {
    this.apiContract = apiContract
  }

  public abstract handleRequest(
    req: FastifyRequest<{
      Body: never
      Headers: InferredOptionalSchema<RequestHeaderSchema>
      Params: InferredOptionalSchema<PathParamsSchema>
      Querystring: InferredOptionalSchema<RequestQuerySchema>
      Reply: InferredOptionalSchema<SuccessResponseBodySchema>
    }>,
    reply: FastifyReply<{ Body: z.infer<SuccessResponseBodySchema> }>,
  ): Promise<void>

  public buildRoute() {
    this.route = buildFastifyNoPayloadRoute(
      this.apiContract,
      async (
        req: FastifyRequest<{
          Body: never
          Headers: InferredOptionalSchema<RequestHeaderSchema>
          Params: InferredOptionalSchema<PathParamsSchema>
          Querystring: InferredOptionalSchema<RequestQuerySchema>
          Reply: InferredOptionalSchema<SuccessResponseBodySchema>
        }>,
        reply: FastifyReply<{ Body: z.infer<SuccessResponseBodySchema> }>,
      ) => this.handleRequest(req, reply),
    )
  }
}
