import {
  buildFastifyNoPayloadRoute,
  buildFastifyPayloadRoute,
} from '@lokalise/fastify-api-contracts'
import {
  buildDeleteRoute, buildGetRoute,
  buildPayloadRoute,
} from '@lokalise/universal-ts-utils/api-contracts/apiContracts'
import {boolean, z} from 'zod'
import { AbstractController, type BuildRoutesReturnType } from '../lib/AbstractController.js'
import type { TestModuleDependencies, TestService } from './TestModule.js'

const REQUEST_BODY_SCHEMA = z.object({
  name: z.string(),
})
const RESPONSE_BODY_SCHEMA = z.object({success: boolean()})
const PATH_PARAMS_SCHEMA = z.object({
  userId: z.string(),
})

const deleteContract = buildDeleteRoute({
  successResponseBodySchema: RESPONSE_BODY_SCHEMA,
  requestPathParamsSchema: PATH_PARAMS_SCHEMA,
  pathResolver: (pathParams) => `/users/${pathParams.userId}`,
})

const getContract = buildGetRoute({
  successResponseBodySchema: RESPONSE_BODY_SCHEMA,
  requestPathParamsSchema: PATH_PARAMS_SCHEMA,
  pathResolver: (pathParams) => `/users/${pathParams.userId}`,
})

const updateContract = buildPayloadRoute({
  method: 'patch',
  requestBodySchema: REQUEST_BODY_SCHEMA,
  successResponseBodySchema: RESPONSE_BODY_SCHEMA,
  requestPathParamsSchema: PATH_PARAMS_SCHEMA,
  pathResolver: (pathParams) => `/users/${pathParams.userId}`,
})

export class TestController extends AbstractController<typeof TestController.contracts> {
  public static contracts = {
    getItem: getContract,
    deleteItem: deleteContract,
    updateItem: updateContract,
  } as const
  private readonly service: TestService

  constructor({ testService }: TestModuleDependencies) {
    super()
    this.service = testService
  }

  private getItem = buildFastifyNoPayloadRoute(
    TestController.contracts.getItem,
    async (req, reply) => {
      req.log.info(req.params.userId)
      this.service.execute()
      await reply.status(200).send({success: true})
    },
  )

  private deleteItem = buildFastifyNoPayloadRoute(
    TestController.contracts.deleteItem,
    async (req, reply) => {
      req.log.info(req.params.userId)
      this.service.execute()
      await reply.status(200).send({success: true})
    },
  )

  private updateItem = buildFastifyPayloadRoute(
    TestController.contracts.updateItem,
    async (req, reply) => {
      req.log.info(req.params.userId)
      this.service.execute()
      await reply.status(200).send({success: true})
    },
  )

  public buildRoutes(): BuildRoutesReturnType<typeof TestController.contracts> {
    return {
      getItem: this.getItem,
      updateItem: this.updateItem,
      deleteItem: this.deleteItem,
    }
  }
}
