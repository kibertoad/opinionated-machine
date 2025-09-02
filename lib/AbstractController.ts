import type {
  CommonRouteDefinition,
  DeleteRouteDefinition,
  GetRouteDefinition,
  PayloadRouteDefinition,
} from '@lokalise/api-contracts'
import type {
  buildFastifyNoPayloadRoute,
  buildFastifyPayloadRoute,
} from '@lokalise/fastify-api-contracts'
import type { z } from 'zod/v4'

// biome-ignore lint/suspicious/noExplicitAny: we don't care about specific generics here
type AnyCommonRouteDefinition = CommonRouteDefinition<any, any, any, any, any, any, any>
type OptionalZodSchema = z.Schema | undefined

type FastifyPayloadRouteReturnType<
  RequestBody extends OptionalZodSchema,
  ResponseBody extends OptionalZodSchema,
  Path extends OptionalZodSchema,
  Query extends OptionalZodSchema,
  Headers extends OptionalZodSchema,
  IsNonJSONResponseExpected extends boolean,
  IsEmptyResponseExpected extends boolean,
> = ReturnType<
  typeof buildFastifyPayloadRoute<
    RequestBody,
    ResponseBody,
    Path,
    Query,
    Headers,
    IsNonJSONResponseExpected,
    IsEmptyResponseExpected
  >
>
type FastifyNoPayloadRouteReturnType<
  RequestBody extends OptionalZodSchema,
  Path extends OptionalZodSchema,
  Query extends OptionalZodSchema,
  Headers extends OptionalZodSchema,
> = ReturnType<typeof buildFastifyNoPayloadRoute<RequestBody, Path, Query, Headers>>

export type BuildRoutesReturnType<APIContracts extends Record<string, AnyCommonRouteDefinition>> = {
  [K in keyof APIContracts]: APIContracts[K] extends PayloadRouteDefinition<
    infer RequestBody,
    infer ResponseBody,
    infer Path,
    infer Query,
    infer Headers,
    infer IsNonJSONResponseExpected,
    infer IsEmptyResponseExpected,
    infer _ResponseSchemasByStatusCode
  >
    ? FastifyPayloadRouteReturnType<
        RequestBody,
        ResponseBody,
        Path,
        Query,
        Headers,
        IsNonJSONResponseExpected,
        IsEmptyResponseExpected
      >
    : APIContracts[K] extends
          | GetRouteDefinition<
              infer GetResponseBody,
              infer GetPath,
              infer GetQuery,
              infer GetHeaders,
              infer _GetIsNonJSONResponseExpected,
              infer _GetIsEmptyResponseExpected,
              infer _GetResponseSchemasByStatusCode
            >
          | DeleteRouteDefinition<
              infer DeleteResponseBody,
              infer DeletePath,
              infer DeleteQuery,
              infer DeleteHeaders,
              infer _DeleteIsNonJSONResponseExpected,
              infer _DeleteIsEmptyResponseExpected,
              infer _DeleteResponseSchemasByStatusCode
            >
      ? FastifyNoPayloadRouteReturnType<
          GetResponseBody | DeleteResponseBody,
          GetPath | DeletePath,
          GetQuery | DeleteQuery,
          GetHeaders | DeleteHeaders
        >
      : never
}

export abstract class AbstractController<
  APIContracts extends Record<string, AnyCommonRouteDefinition>,
> {
  public abstract buildRoutes(): BuildRoutesReturnType<APIContracts>
}
