// Handler and context types come straight from @lokalise/fastify-api-contracts —
// re-exported here so controllers can type handlers without importing the peer directly.
export type {
  ApiHandlerContext,
  ApiHandlerReply,
  InferApiHandler,
  InferApiHandlerRequest,
  InferApiHandlerResult,
  InferContractResponseContentTypes,
} from '@lokalise/fastify-api-contracts'
export { AbstractApiController } from './AbstractApiController.ts'
export { type ApiRouteOptions, buildApiRoute } from './apiRouteBuilder.ts'
export {
  ApiSseConnectionRegistry,
  getApiSseConnectionRegistry,
  getSessionRooms,
  type SSERoomsOptions,
  withSessionRooms,
} from './apiSseConnectionRegistry.ts'
export { asApiControllerClass } from './asApiControllerClass.ts'
