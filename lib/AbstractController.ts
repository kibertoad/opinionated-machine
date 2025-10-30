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
  RequestHeaders extends OptionalZodSchema,
  ResponseHeaders extends OptionalZodSchema,
  IsNonJSONResponseExpected extends boolean,
  IsEmptyResponseExpected extends boolean,
> = ReturnType<
  typeof buildFastifyPayloadRoute<
    RequestBody,
    ResponseBody,
    Path,
    Query,
    RequestHeaders,
    ResponseHeaders,
    IsNonJSONResponseExpected,
    IsEmptyResponseExpected
  >
>
type FastifyNoPayloadRouteReturnType<
  RequestBody extends OptionalZodSchema,
  Path extends OptionalZodSchema,
  Query extends OptionalZodSchema,
  RequestHeaders extends OptionalZodSchema,
  ResponseHeaders extends OptionalZodSchema,
> = ReturnType<
  typeof buildFastifyNoPayloadRoute<RequestBody, Path, Query, RequestHeaders, ResponseHeaders>
>

export type BuildRoutesReturnType<APIContracts extends Record<string, AnyCommonRouteDefinition>> = {
  [K in keyof APIContracts]: APIContracts[K] extends PayloadRouteDefinition<
    infer RequestBody,
    infer ResponseBody,
    infer Path,
    infer Query,
    infer RequestHeaders,
    infer ResponseHeaders,
    infer IsNonJSONResponseExpected,
    infer IsEmptyResponseExpected,
    infer _ResponseSchemasByStatusCode
  >
    ? FastifyPayloadRouteReturnType<
        RequestBody,
        ResponseBody,
        Path,
        Query,
        RequestHeaders,
        ResponseHeaders,
        IsNonJSONResponseExpected,
        IsEmptyResponseExpected
      >
    : APIContracts[K] extends
          | GetRouteDefinition<
              infer GetResponseBody,
              infer GetPath,
              infer GetQuery,
              infer GetRequestHeaders,
              infer GetResponseHeaders,
              infer _GetIsNonJSONResponseExpected,
              infer _GetIsEmptyResponseExpected,
              infer _GetResponseSchemasByStatusCode
            >
          | DeleteRouteDefinition<
              infer DeleteResponseBody,
              infer DeletePath,
              infer DeleteQuery,
              infer DeleteRequestHeaders,
              infer DeleteResponseHeaders,
              infer _DeleteIsNonJSONResponseExpected,
              infer _DeleteIsEmptyResponseExpected,
              infer _DeleteResponseSchemasByStatusCode
            >
      ? FastifyNoPayloadRouteReturnType<
          GetResponseBody | DeleteResponseBody,
          GetPath | DeletePath,
          GetQuery | DeleteQuery,
          GetRequestHeaders | DeleteRequestHeaders,
          GetResponseHeaders | DeleteResponseHeaders
        >
      : never
}

export abstract class AbstractController<
  APIContracts extends Record<string, AnyCommonRouteDefinition>,
> {
  public abstract buildRoutes(): BuildRoutesReturnType<APIContracts>
}
