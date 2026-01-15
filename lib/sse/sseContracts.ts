import type { z } from 'zod'
import type { SSERouteHandler } from './sseTypes.ts'

/**
 * Supported HTTP methods for SSE routes.
 * While traditional SSE uses GET, modern APIs (e.g., OpenAI) use POST
 * to send request parameters in the body while streaming responses.
 */
export type SSEMethod = 'GET' | 'POST' | 'PUT' | 'PATCH'

/**
 * Definition for an SSE route with type-safe contracts.
 *
 * @template Method - HTTP method (GET, POST, PUT, PATCH)
 * @template Path - URL path pattern
 * @template Params - Path parameters schema
 * @template Query - Query string parameters schema
 * @template RequestHeaders - Request headers schema
 * @template Body - Request body schema (for POST/PUT/PATCH)
 * @template Events - Map of event name to event data schema
 */
export type SSERouteDefinition<
  Method extends SSEMethod = SSEMethod,
  Path extends string = string,
  Params extends z.ZodTypeAny = z.ZodTypeAny,
  Query extends z.ZodTypeAny = z.ZodTypeAny,
  RequestHeaders extends z.ZodTypeAny = z.ZodTypeAny,
  Body extends z.ZodTypeAny | undefined = undefined,
  Events extends Record<string, z.ZodTypeAny> = Record<string, z.ZodTypeAny>,
> = {
  method: Method
  path: Path
  params: Params
  query: Query
  requestHeaders: RequestHeaders
  body: Body
  events: Events
  isSSE: true
}

/**
 * Type representing any SSE route definition (for use in generic constraints)
 */
export type AnySSERouteDefinition = SSERouteDefinition<
  SSEMethod,
  string,
  z.ZodTypeAny,
  z.ZodTypeAny,
  z.ZodTypeAny,
  z.ZodTypeAny | undefined,
  Record<string, z.ZodTypeAny>
>

/**
 * Configuration for building a GET SSE route
 */
export type SSERouteConfig<
  Path extends string,
  Params extends z.ZodTypeAny,
  Query extends z.ZodTypeAny,
  RequestHeaders extends z.ZodTypeAny,
  Events extends Record<string, z.ZodTypeAny>,
> = {
  path: Path
  params: Params
  query: Query
  requestHeaders: RequestHeaders
  events: Events
}

/**
 * Configuration for building a POST/PUT/PATCH SSE route with request body
 */
export type PayloadSSERouteConfig<
  Path extends string,
  Params extends z.ZodTypeAny,
  Query extends z.ZodTypeAny,
  RequestHeaders extends z.ZodTypeAny,
  Body extends z.ZodTypeAny,
  Events extends Record<string, z.ZodTypeAny>,
> = {
  method?: 'POST' | 'PUT' | 'PATCH'
  path: Path
  params: Params
  query: Query
  requestHeaders: RequestHeaders
  body: Body
  events: Events
}

/**
 * Build a GET SSE route definition (traditional SSE).
 *
 * Use this for long-lived connections where the client subscribes
 * to receive events over time (e.g., notifications, real-time updates).
 *
 * @example
 * ```typescript
 * const notificationsStream = buildSSERoute({
 *   path: '/api/notifications/stream',
 *   params: z.object({}),
 *   query: z.object({ userId: z.string().uuid() }),
 *   requestHeaders: z.object({ authorization: z.string() }),
 *   events: {
 *     notification: z.object({ id: z.string(), message: z.string() }),
 *   },
 * })
 * ```
 */
export function buildSSERoute<
  Path extends string,
  Params extends z.ZodTypeAny,
  Query extends z.ZodTypeAny,
  RequestHeaders extends z.ZodTypeAny,
  Events extends Record<string, z.ZodTypeAny>,
>(
  config: SSERouteConfig<Path, Params, Query, RequestHeaders, Events>,
): SSERouteDefinition<'GET', Path, Params, Query, RequestHeaders, undefined, Events> {
  return {
    method: 'GET',
    path: config.path,
    params: config.params,
    query: config.query,
    requestHeaders: config.requestHeaders,
    body: undefined,
    events: config.events,
    isSSE: true,
  }
}

/**
 * Build a POST/PUT/PATCH SSE route definition (OpenAI-style streaming API).
 *
 * Use this for request-response streaming where the client sends a request
 * body and receives a stream of events in response (e.g., chat completions).
 *
 * @example
 * ```typescript
 * const chatCompletionStream = buildPayloadSSERoute({
 *   method: 'POST',
 *   path: '/api/ai/chat/completions',
 *   params: z.object({}),
 *   query: z.object({}),
 *   requestHeaders: z.object({ authorization: z.string() }),
 *   body: z.object({
 *     model: z.string(),
 *     messages: z.array(z.object({ role: z.string(), content: z.string() })),
 *     stream: z.literal(true),
 *   }),
 *   events: {
 *     chunk: z.object({ content: z.string() }),
 *     done: z.object({ usage: z.object({ tokens: z.number() }) }),
 *   },
 * })
 * ```
 */
export function buildPayloadSSERoute<
  Path extends string,
  Params extends z.ZodTypeAny,
  Query extends z.ZodTypeAny,
  RequestHeaders extends z.ZodTypeAny,
  Body extends z.ZodTypeAny,
  Events extends Record<string, z.ZodTypeAny>,
>(
  config: PayloadSSERouteConfig<Path, Params, Query, RequestHeaders, Body, Events>,
): SSERouteDefinition<'POST' | 'PUT' | 'PATCH', Path, Params, Query, RequestHeaders, Body, Events> {
  return {
    method: config.method ?? 'POST',
    path: config.path,
    params: config.params,
    query: config.query,
    requestHeaders: config.requestHeaders,
    body: config.body,
    events: config.events,
    isSSE: true,
  }
}

/**
 * Type-inference helper for SSE handlers.
 *
 * Similar to `buildFastifyPayloadRoute`, this function provides automatic
 * type inference for the request and connection parameters based on the contract.
 *
 * @example
 * ```typescript
 * class MyController extends AbstractSSEController<{ stream: typeof streamContract }> {
 *   private handleStream = buildSSEHandler(
 *     streamContract,
 *     async (request, connection) => {
 *       // request.body is typed from contract
 *       // request.query is typed from contract
 *       const { message } = request.body
 *     },
 *   )
 *
 *   buildSSERoutes() {
 *     return {
 *       stream: {
 *         contract: streamContract,
 *         handler: this.handleStream,
 *       },
 *     }
 *   }
 * }
 * ```
 */
export function buildSSEHandler<Contract extends AnySSERouteDefinition>(
  _contract: Contract,
  handler: SSERouteHandler<
    z.infer<Contract['params']>,
    z.infer<Contract['query']>,
    z.infer<Contract['requestHeaders']>,
    Contract['body'] extends z.ZodTypeAny ? z.infer<Contract['body']> : undefined
  >,
): typeof handler {
  return handler
}
