import { buildRestContract } from '@lokalise/api-contracts'
import { buildFastifyRoute } from '@lokalise/fastify-api-contracts'
import { boolean, z } from 'zod/v4'
import { AbstractController, type BuildRoutesReturnType } from '../lib/AbstractController.js'
import type { TestModuleDependencies, TestService } from './TestModule.js'

const REQUEST_BODY_SCHEMA = z.object({
  name: z.string(),
})
const RESPONSE_BODY_SCHEMA = z.object({ success: boolean() })
const PATH_PARAMS_SCHEMA = z.object({
  userId: z.string(),
})

const deleteContract = buildRestContract({
  method: 'delete',
  successResponseBodySchema: RESPONSE_BODY_SCHEMA,
  requestPathParamsSchema: PATH_PARAMS_SCHEMA,
  pathResolver: (pathParams) => `/users/${pathParams.userId}`,
})

const getContract = buildRestContract({
  method: 'get',
  successResponseBodySchema: RESPONSE_BODY_SCHEMA,
  requestPathParamsSchema: PATH_PARAMS_SCHEMA,
  pathResolver: (pathParams) => `/users/${pathParams.userId}`,
})

const updateContract = buildRestContract({
  method: 'patch',
  requestBodySchema: REQUEST_BODY_SCHEMA,
  successResponseBodySchema: z.undefined(),
  isEmptyResponseExpected: true,
  isNonJSONResponseExpected: true,
  requestPathParamsSchema: PATH_PARAMS_SCHEMA,
  pathResolver: (pathParams) => `/users/${pathParams.userId}`,
})

const createContract = buildRestContract({
  method: 'post',
  requestBodySchema: REQUEST_BODY_SCHEMA,
  successResponseBodySchema: RESPONSE_BODY_SCHEMA,
  pathResolver: () => '/users',
})

export class TestController extends AbstractController<typeof TestController.contracts> {
  public static contracts = {
    getItem: getContract,
    deleteItem: deleteContract,
    updateItem: updateContract,
    createItem: createContract,
  } as const
  private readonly service: TestService

  constructor({ testService }: TestModuleDependencies) {
    super()
    this.service = testService
  }

  private getItem = buildFastifyRoute(TestController.contracts.getItem, async (req, reply) => {
    req.log.info(req.params.userId)
    this.service.execute()
    await reply.status(200).send({ success: true })
  })

  private deleteItem = buildFastifyRoute(
    TestController.contracts.deleteItem,
    async (req, reply) => {
      req.log.info(req.params.userId)
      this.service.execute()
      await reply.status(200).send({ success: true })
    },
  )

  private createItem = buildFastifyRoute(TestController.contracts.createItem, async (_, reply) => {
    await reply.status(200).send({ success: true })
  })

  private updateItem = buildFastifyRoute(
    TestController.contracts.updateItem,
    async (req, reply) => {
      req.log.info(req.params.userId)
      this.service.execute()
      await reply.status(200).send({ success: true })
    },
  )

  public buildRoutes(): BuildRoutesReturnType<typeof TestController.contracts> {
    return {
      getItem: this.getItem,
      deleteItem: this.deleteItem,
      updateItem: this.updateItem,
      createItem: this.createItem,
    }
  }
}
