import { buildFastifyNoPayloadRoute } from '@lokalise/fastify-api-contracts'
import { buildDeleteRoute } from '@lokalise/universal-ts-utils/api-contracts/apiContracts'
import { z } from 'zod'
import { AbstractController } from '../lib/AbstractController.js'

const BODY_SCHEMA = z.object({})
const PATH_PARAMS_SCHEMA = z.object({
  userId: z.string(),
})

const contract = buildDeleteRoute({
  successResponseBodySchema: BODY_SCHEMA,
  requestPathParamsSchema: PATH_PARAMS_SCHEMA,
  pathResolver: (pathParams) => `/users/${pathParams.userId}`,
})

export class TestController extends AbstractController<typeof TestController.contracts> {
  public static contracts = { deleteItem: contract } as const

  public buildRoutes() {
    return {
      deleteItem: buildFastifyNoPayloadRoute(
        TestController.contracts.deleteItem,
        async (req, reply) => {
          req.log.info(req.params.userId)
          await reply.status(204).send()
        },
      ),
    }
  }
}
