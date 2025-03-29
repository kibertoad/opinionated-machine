import {
  buildFastifyNoPayloadRoute,
  buildFastifyPayloadRoute,
} from '@lokalise/fastify-api-contracts'
import {
  buildDeleteRoute,
  buildPayloadRoute,
} from '@lokalise/universal-ts-utils/api-contracts/apiContracts'
import { z } from 'zod'
import { AbstractController } from '../lib/AbstractController.js'
import type { TestModuleDependencies, TestService } from './TestModule.js'

const REQUEST_BODY_SCHEMA = z.object({
  name: z.string(),
})
const BODY_SCHEMA = z.object({})
const PATH_PARAMS_SCHEMA = z.object({
  userId: z.string(),
})

const deleteContract = buildDeleteRoute({
  successResponseBodySchema: BODY_SCHEMA,
  requestPathParamsSchema: PATH_PARAMS_SCHEMA,
  pathResolver: (pathParams) => `/users/${pathParams.userId}`,
})

const updateContract = buildPayloadRoute({
  method: 'patch',
  requestBodySchema: REQUEST_BODY_SCHEMA,
  successResponseBodySchema: BODY_SCHEMA,
  requestPathParamsSchema: PATH_PARAMS_SCHEMA,
  pathResolver: (pathParams) => `/users/${pathParams.userId}`,
})

export class TestController extends AbstractController<typeof TestController.contracts> {
  public static contracts = {
    deleteItem: deleteContract,
    updateItem: updateContract,
  } as const
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

  private updateItem = buildFastifyPayloadRoute(
    TestController.contracts.updateItem,
    async (req, reply) => {
      req.log.info(req.params.userId)
      this.service.execute()
      await reply.status(204).send()
    },
  )

  public buildRoutes() {
    return {
      deleteItem: this.deleteItem,
      updateItem: this.updateItem,
    }
  }
}
