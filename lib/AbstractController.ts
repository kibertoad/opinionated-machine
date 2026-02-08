import type {
  CommonRouteDefinition,
  DeleteRouteDefinition,
  GetRouteDefinition,
  PayloadRouteDefinition,
} from '@lokalise/api-contracts'
import type { buildFastifyRoute } from '@lokalise/fastify-api-contracts'
import type { z } from 'zod/v4'

// biome-ignore lint/suspicious/noExplicitAny: we don't care about specific generics here
type AnyCommonRouteDefinition = CommonRouteDefinition<any, any, any, any, any, any, any, any>
type OptionalZodSchema = z.Schema | undefined

type FastifyPayloadRouteReturnType<
  RequestBody extends OptionalZodSchema,
  ResponseBody extends OptionalZodSchema,
  Path extends OptionalZodSchema,
  Query extends OptionalZodSchema,
  Headers extends OptionalZodSchema,
  ResponseHeaders extends OptionalZodSchema,
  IsNonJSONResponseExpected extends boolean,
  IsEmptyResponseExpected extends boolean,
  // biome-ignore lint/suspicious/noExplicitAny: ResponseSchemasByStatusCode type is complex
  ResponseSchemasByStatusCode extends Record<number, any> | undefined,
> = ReturnType<
  typeof buildFastifyRoute<
    RequestBody,
    ResponseBody,
    Path,
    Query,
    Headers,
    ResponseHeaders,
    IsNonJSONResponseExpected,
    IsEmptyResponseExpected,
    ResponseSchemasByStatusCode
  >
>
type FastifyNoPayloadRouteReturnType<
  ResponseBody extends OptionalZodSchema,
  Path extends OptionalZodSchema,
  Query extends OptionalZodSchema,
  Headers extends OptionalZodSchema,
  ResponseHeaders extends OptionalZodSchema,
  IsNonJSONResponseExpected extends boolean,
  IsEmptyResponseExpected extends boolean,
  // biome-ignore lint/suspicious/noExplicitAny: ResponseSchemasByStatusCode type is complex
  ResponseSchemasByStatusCode extends Record<number, any> | undefined,
> = ReturnType<
  typeof buildFastifyRoute<
    undefined,
    ResponseBody,
    Path,
    Query,
    Headers,
    ResponseHeaders,
    IsNonJSONResponseExpected,
    IsEmptyResponseExpected,
    ResponseSchemasByStatusCode
  >
>

export type BuildRoutesReturnType<APIContracts extends Record<string, AnyCommonRouteDefinition>> = {
  [K in keyof APIContracts]: APIContracts[K] extends PayloadRouteDefinition<
    infer RequestBody,
    infer ResponseBody,
    infer Path,
    infer Query,
    infer Headers,
    infer ResponseHeaders,
    infer IsNonJSONResponseExpected,
    infer IsEmptyResponseExpected,
    infer ResponseSchemasByStatusCode
  >
    ? FastifyPayloadRouteReturnType<
        RequestBody,
        ResponseBody,
        Path,
        Query,
        Headers,
        ResponseHeaders,
        IsNonJSONResponseExpected,
        IsEmptyResponseExpected,
        ResponseSchemasByStatusCode
      >
    : APIContracts[K] extends
          | GetRouteDefinition<
              infer GetResponseBody,
              infer GetPath,
              infer GetQuery,
              infer GetHeaders,
              infer GetResponseHeaders,
              infer GetIsNonJSONResponseExpected,
              infer GetIsEmptyResponseExpected,
              infer GetResponseSchemasByStatusCode
            >
          | DeleteRouteDefinition<
              infer DeleteResponseBody,
              infer DeletePath,
              infer DeleteQuery,
              infer DeleteHeaders,
              infer DeleteResponseHeaders,
              infer DeleteIsNonJSONResponseExpected,
              infer DeleteIsEmptyResponseExpected,
              infer DeleteResponseSchemasByStatusCode
            >
      ? FastifyNoPayloadRouteReturnType<
          GetResponseBody | DeleteResponseBody,
          GetPath | DeletePath,
          GetQuery | DeleteQuery,
          GetHeaders | DeleteHeaders,
          GetResponseHeaders | DeleteResponseHeaders,
          GetIsNonJSONResponseExpected | DeleteIsNonJSONResponseExpected,
          GetIsEmptyResponseExpected | DeleteIsEmptyResponseExpected,
          GetResponseSchemasByStatusCode | DeleteResponseSchemasByStatusCode
        >
      : never
}

export abstract class AbstractController<
  APIContracts extends Record<string, AnyCommonRouteDefinition>,
> {
  public abstract buildRoutes(): BuildRoutesReturnType<APIContracts>
}
