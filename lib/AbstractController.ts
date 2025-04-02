import type {buildFastifyNoPayloadRoute, buildFastifyPayloadRoute} from '@lokalise/fastify-api-contracts'
import type {
  CommonRouteDefinition,
  DeleteRouteDefinition, GetRouteDefinition, PayloadRouteDefinition
} from '@lokalise/universal-ts-utils/api-contracts/apiContracts'

// biome-ignore lint/suspicious/noExplicitAny: we don't care about specific generics here
export type AnyCommonRouteDefinition = CommonRouteDefinition<any, any, any, any, any, any, any>

// TODO: Try to simplify by using CommonRouteDefinition directly
export type BuildRoutesReturnType<APIContracts extends Record<string, AnyCommonRouteDefinition>> = {
  [K in keyof APIContracts]: APIContracts[K] extends DeleteRouteDefinition<
          unknown,
          infer A,
          infer B,
          infer C,
          infer D
      >
      ? ReturnType<typeof buildFastifyNoPayloadRoute<A, B, C, D>>
      : APIContracts[K] extends GetRouteDefinition<unknown, infer A, infer B, infer C, infer D>
          ? ReturnType<typeof buildFastifyNoPayloadRoute<A, B, C, D>>
          : APIContracts[K] extends PayloadRouteDefinition<
                  unknown,
                  infer A,
                  infer B,
                  infer C,
                  infer D,
                  infer E,
                  infer F,
                  infer G
              >
              ? ReturnType<typeof buildFastifyPayloadRoute<A, B, C, D, E, F, G>>
              : never
}

export abstract class AbstractController<
  APIContracts extends Record<string, AnyCommonRouteDefinition>,
> {
  public abstract buildRoutes(): BuildRoutesReturnType<APIContracts>
}
