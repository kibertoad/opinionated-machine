import { defineApiContract } from '@lokalise/api-contracts'
import { z } from 'zod/v4'
import { AbstractApiController, buildApiRoute } from '../lib/api-contracts/index.js'
import { withGatewayMetadata } from '../lib/gateway/index.js'
import type { TestModuleDependencies, TestService } from './TestModule.js'

const REQUEST_BODY_SCHEMA = z.object({
  name: z.string(),
})
const RESPONSE_BODY_SCHEMA = z.object({ success: z.boolean() })
const PATH_PARAMS_SCHEMA = z.object({
  userId: z.string(),
})

const deleteContract = defineApiContract({
  visibility: 'public',
  method: 'delete',
  summary: 'Delete user',
  requestPathParamsSchema: PATH_PARAMS_SCHEMA,
  pathResolver: (pathParams) => `/users/${pathParams.userId}`,
  responsesByStatusCode: { 200: RESPONSE_BODY_SCHEMA },
})

const getContract = defineApiContract({
  visibility: 'public',
  method: 'get',
  summary: 'Get user',
  requestPathParamsSchema: PATH_PARAMS_SCHEMA,
  pathResolver: (pathParams) => `/users/${pathParams.userId}`,
  responsesByStatusCode: { 200: RESPONSE_BODY_SCHEMA },
})

const updateContract = defineApiContract({
  visibility: 'public',
  method: 'patch',
  summary: 'Update user',
  requestBodySchema: REQUEST_BODY_SCHEMA,
  requestPathParamsSchema: PATH_PARAMS_SCHEMA,
  pathResolver: (pathParams) => `/users/${pathParams.userId}`,
  responsesByStatusCode: { 204: { allowNoBody: true } },
})

const createContract = defineApiContract({
  visibility: 'public',
  method: 'post',
  summary: 'Create user',
  requestBodySchema: REQUEST_BODY_SCHEMA,
  pathResolver: () => '/users',
  responsesByStatusCode: { 200: RESPONSE_BODY_SCHEMA },
})

export class TestController extends AbstractApiController<typeof TestController.contracts> {
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

  readonly routes = {
    // Annotated with gateway metadata so DIContext.buildGatewayManifest()
    // exercises the symbol-read path in our integration tests.
    getItem: withGatewayMetadata(
      TestController.contracts.getItem,
      buildApiRoute(TestController.contracts.getItem, (req) => {
        req.log.info(req.params.userId)
        this.service.execute()
        return { status: 200, body: { success: true } }
      }),
      { cache: { ttl: '60s' } },
    ),
    deleteItem: buildApiRoute(TestController.contracts.deleteItem, (req) => {
      req.log.info(req.params.userId)
      this.service.execute()
      return { status: 200, body: { success: true } }
    }),
    updateItem: buildApiRoute(TestController.contracts.updateItem, (req) => {
      req.log.info(req.params.userId)
      this.service.execute()
      return { status: 204, body: null }
    }),
    createItem: buildApiRoute(TestController.contracts.createItem, () => ({
      status: 200,
      body: { success: true },
    })),
  }
}
