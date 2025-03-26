import type { RouteType } from '@lokalise/fastify-api-contracts'
import type {
  DeleteRouteDefinition,
  GetRouteDefinition,
  PayloadRouteDefinition,
} from '@lokalise/universal-ts-utils/api-contracts/apiContracts'

export abstract class AbstractController<
  APIContracts extends Record<
    string,
    // biome-ignore lint/suspicious/noExplicitAny: we don't care about specific generics here
    | DeleteRouteDefinition<any, any, any>
    // biome-ignore lint/suspicious/noExplicitAny: we don't care about specific generics here
    | GetRouteDefinition<any, any, any>
    // biome-ignore lint/suspicious/noExplicitAny: we don't care about specific generics here
    | PayloadRouteDefinition<any, any, any>
  >,
> {
  public abstract buildRoutes(): Record<keyof APIContracts, RouteType>
}
