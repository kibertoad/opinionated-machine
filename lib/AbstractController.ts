import type { RouteType } from '@lokalise/fastify-api-contracts'
import type { DeleteRouteDefinition } from '@lokalise/universal-ts-utils/dist/public/api-contracts/apiContracts'

export abstract class AbstractController<
  APIContracts extends Record<string, DeleteRouteDefinition<unknown>>,
> {
  protected abstract contracts: APIContracts

  public abstract buildRoutes(): Record<keyof APIContracts, RouteType>
}
