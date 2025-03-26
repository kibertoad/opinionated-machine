import type { RouteType } from '@lokalise/fastify-api-contracts'
import type {
  DeleteRouteDefinition,
  GetRouteDefinition,
  PayloadRouteDefinition,
} from '@lokalise/universal-ts-utils/api-contracts/apiContracts'

export abstract class AbstractController<
  APIContracts extends Record<
    string,
    DeleteRouteDefinition<unknown> | GetRouteDefinition<unknown> | PayloadRouteDefinition<unknown>
  >,
> {
  protected abstract contracts: APIContracts

  public abstract buildRoutes(): Record<keyof APIContracts, RouteType>
}
