import type { RouteType } from '@lokalise/fastify-api-contracts'
import type { CommonRouteDefinition } from '@lokalise/universal-ts-utils/api-contracts/apiContracts'

// biome-ignore lint/suspicious/noExplicitAny: we don't care about specific generics here
export type AnyCommonRouteDefinition = CommonRouteDefinition<any, any, any, any, any, any, any>

export abstract class AbstractController<
  APIContracts extends Record<string, AnyCommonRouteDefinition>,
> {
  public abstract buildRoutes(): Record<keyof APIContracts, RouteType>
}
