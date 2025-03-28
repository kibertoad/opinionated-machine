import { buildFastifyNoPayloadRoute } from '@lokalise/fastify-api-contracts'
import { buildDeleteRoute } from '@lokalise/universal-ts-utils/api-contracts/apiContracts'
import { z } from 'zod'
import { AbstractController } from '../lib/AbstractController.js'
import type { TestModuleDependencies, TestService } from './TestModule.js'

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
  private readonly service: TestService

  constructor({ testService }: TestModuleDependencies) {
    super()
    this.service = testService
  }

  private deleteItem = buildFastifyNoPayloadRoute(
    TestController.contracts.deleteItem,
    async (req, reply) => {
      req.log.info(req.params.userId)
      this.service.execute()
      await reply.status(204).send()
    },
  )

  public buildRoutes() {
    return {
      deleteItem: this.deleteItem,
    }
  }
}
