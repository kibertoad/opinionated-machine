import type {
  buildFastifyNoPayloadRoute,
  buildFastifyPayloadRoute,
} from '@lokalise/fastify-api-contracts'
import type {
  CommonRouteDefinition,
  DeleteRouteDefinition,
  GetRouteDefinition,
  PayloadRouteDefinition,
} from '@lokalise/universal-ts-utils/api-contracts/apiContracts'
import type { z } from 'zod'

// biome-ignore lint/suspicious/noExplicitAny: we don't care about specific generics here
type AnyCommonRouteDefinition = CommonRouteDefinition<any, any, any, any, any, any, any>
type OptionalZodSchema = z.Schema | undefined

type FastifyPayloadRoute<
  RequestBody extends OptionalZodSchema,
  ResponseBody extends OptionalZodSchema,
  Path extends OptionalZodSchema,
  Query extends OptionalZodSchema,
  Headers extends OptionalZodSchema,
> = ReturnType<typeof buildFastifyPayloadRoute<RequestBody, ResponseBody, Path, Query, Headers>>
type FastifyNoPayloadRoute<
  RequestBody extends OptionalZodSchema,
  Path extends OptionalZodSchema,
  Query extends OptionalZodSchema,
  Headers extends OptionalZodSchema,
> = ReturnType<typeof buildFastifyNoPayloadRoute<RequestBody, Path, Query, Headers>>

export type BuildRoutesReturnType<APIContracts extends Record<string, AnyCommonRouteDefinition>> = {
  [K in keyof APIContracts]: APIContracts[K] extends PayloadRouteDefinition<
    unknown,
    infer RequestBody,
    infer ResponseBody,
    infer Path,
    infer Query,
    infer Headers
  >
    ? FastifyPayloadRoute<RequestBody, ResponseBody, Path, Query, Headers>
    : APIContracts[K] extends GetRouteDefinition<
          unknown,
          infer GetRequestBody,
          infer GetPath,
          infer GetQuery,
          infer GetHeaders
        > | DeleteRouteDefinition<
            unknown,
            infer DeleteRequestBody,
            infer DeletePath,
            infer DeleteQuery,
            infer DeleteHeaders
        >
      ? FastifyNoPayloadRoute<GetRequestBody | DeleteRequestBody, GetPath | DeletePath, GetQuery | DeleteQuery, GetHeaders | DeleteHeaders>
      : never
}

export abstract class AbstractController<
  APIContracts extends Record<string, AnyCommonRouteDefinition>,
> {
  public abstract buildRoutes(): BuildRoutesReturnType<APIContracts>
}
