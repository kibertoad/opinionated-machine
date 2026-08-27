import type { FastifyInstance, FastifyPluginCallback, RouteOptions } from 'fastify'
import fp from 'fastify-plugin'

/**
 * Route-level knobs applied to a generated document route — most importantly
 * the auth hook guarding the internal document.
 */
export type OpenApiDocumentRouteOptions = Partial<
  Pick<RouteOptions, 'onRequest' | 'preValidation' | 'preHandler' | 'config' | 'schema'>
>

export type FastifyOpenApiDocsPluginOptions = {
  /**
   * Fastify decorator holding the public document generator — the `decorator`
   * option of the `@fastify/swagger` registration configured with
   * `openApiVisibilityTransform({ audience: 'public' })`.
   *
   * @default 'swagger'
   */
  publicDecorator?: string

  /**
   * Fastify decorator holding the internal document generator — the
   * `decorator` option of the `@fastify/swagger` registration configured with
   * `openApiVisibilityTransform({ audience: 'internal' })`.
   *
   * @default 'internalSwagger'
   */
  internalDecorator?: string

  /** Path serving the public document as JSON. Omit to register nothing. */
  publicRoute?: string

  /**
   * Path serving the internal document as JSON. Omit to register nothing.
   *
   * **Opt-in, and worth guarding.** The internal document lists endpoints that
   * were deliberately kept out of the public spec; pair it with
   * `internalRouteOptions.onRequest` unless the path is already unreachable
   * from outside the cluster.
   */
  internalRoute?: string

  /** Extra route options for the public document route. */
  publicRouteOptions?: OpenApiDocumentRouteOptions

  /** Extra route options for the internal document route — put auth here. */
  internalRouteOptions?: OpenApiDocumentRouteOptions

  /**
   * Tag used to keep the document routes out of every document, matching the
   * `hiddenTag` of the `@fastify/swagger` registrations.
   *
   * `hide: true` alone is not enough: `openApiVisibilityTransform` treats an
   * unmarked hidden route as internal and surfaces it in the internal
   * document. The hidden tag is the audience-independent opt-out.
   *
   * @default 'X-HIDDEN'
   */
  hiddenTag?: string
}

type DocumentGenerator = () => unknown

function resolveGenerator(app: FastifyInstance, decorator: string): DocumentGenerator {
  const generator = (app as unknown as Record<string, unknown>)[decorator]
  if (typeof generator !== 'function') {
    throw new Error(
      `fastifyOpenApiDocsPlugin: no "${decorator}" decorator found on the Fastify instance. ` +
        'Register @fastify/swagger with a matching `decorator` option before requesting a ' +
        'document route for it.',
    )
  }
  return generator.bind(app) as DocumentGenerator
}

function registerDocumentRoute(
  app: FastifyInstance,
  url: string,
  decorator: string,
  hiddenTag: string,
  routeOptions: OpenApiDocumentRouteOptions | undefined,
): void {
  app.route({
    method: 'GET',
    url,
    ...routeOptions,
    // The document routes are plumbing, not API surface — keep them out of
    // every document, the internal one included. An explicit `schema` in
    // routeOptions still wins.
    schema: { hide: true, tags: [hiddenTag], ...routeOptions?.schema },
    handler: async () => resolveGenerator(app, decorator)(),
  })
}

/**
 * Optional plugin exposing the public and internal OpenAPI documents under
 * separate paths.
 *
 * Expects `@fastify/swagger` to be registered once per audience (see
 * `openApiVisibilityTransform`), and simply wires each registration's
 * decorator to a route. Both routes are opt-in: passing neither path registers
 * nothing, so adding the plugin can never expose an internal spec by accident.
 *
 * @example
 * ```ts
 * await app.register(fastifyOpenApiDocsPlugin, {
 *   publicRoute: '/documentation/json',
 *   internalRoute: '/documentation/internal/json',
 *   internalRouteOptions: { onRequest: requireInternalNetwork },
 * })
 * ```
 */
const fastifyOpenApiDocsPluginInner: FastifyPluginCallback<FastifyOpenApiDocsPluginOptions> = (
  app: FastifyInstance,
  opts,
  done,
) => {
  const publicDecorator = opts.publicDecorator ?? 'swagger'
  const internalDecorator = opts.internalDecorator ?? 'internalSwagger'
  const hiddenTag = opts.hiddenTag ?? 'X-HIDDEN'

  if (opts.publicRoute) {
    registerDocumentRoute(
      app,
      opts.publicRoute,
      publicDecorator,
      hiddenTag,
      opts.publicRouteOptions,
    )
  }
  if (opts.internalRoute) {
    registerDocumentRoute(
      app,
      opts.internalRoute,
      internalDecorator,
      hiddenTag,
      opts.internalRouteOptions,
    )
  }

  // Fail at boot rather than on the first request to a misconfigured path:
  // @fastify/swagger decorates during its own registration, which may run
  // after this plugin.
  app.addHook('onReady', (readyDone) => {
    try {
      if (opts.publicRoute) resolveGenerator(app, publicDecorator)
      if (opts.internalRoute) resolveGenerator(app, internalDecorator)
      readyDone()
    } catch (err) {
      readyDone(err as Error)
    }
  })

  done()
}

export const fastifyOpenApiDocsPlugin = fp(fastifyOpenApiDocsPluginInner, {
  name: '@opinionated-machine/openapi-docs',
  fastify: '5.x',
})
