import type { FastifyInstance, FastifyPluginCallback } from 'fastify'
import fp from 'fastify-plugin'
import type { DIContext } from '../DIContext.ts'
import type { BuildGatewayManifestOptions } from './manifest/buildManifest.ts'
import type { GatewayManifest } from './manifest/manifestSchema.ts'

/**
 * Function decoration installed on the Fastify instance by
 * `fastifyGatewayPlugin`. Returns the gateway manifest, recomputed on every
 * call so it always reflects the current set of registered controllers.
 *
 * Mirrors the spirit of `@fastify/swagger`'s `app.swagger()`.
 */
export type BuildGatewayManifestFn = (
  overrides?: Partial<BuildGatewayManifestOptions>,
) => GatewayManifest

declare module 'fastify' {
  interface FastifyInstance {
    buildGatewayManifest: BuildGatewayManifestFn
  }
}

export type FastifyGatewayPluginOptions = {
  /**
   * The DI context that owns the controllers whose manifest we expose.
   * The plugin calls `context.buildGatewayManifest()` lazily, so route
   * registration order (plugin first vs. routes first) doesn't matter.
   */
  // biome-ignore lint/suspicious/noExplicitAny: DIContext generics are erased at the plugin boundary
  context: DIContext<any, any, any>
  /** Default options applied to every `app.buildGatewayManifest()` call. */
  defaults: BuildGatewayManifestOptions
  /**
   * If set to a path string, exposes `GET <route>` returning the manifest as
   * JSON. Useful when a CLI / sibling process wants to fetch the manifest
   * over HTTP instead of loading the service code.
   *
   * **Opt-in.** No HTTP route is registered when this is omitted, so adding
   * the plugin can never accidentally expose internal routing topology to
   * unauthenticated callers.
   */
  exposeRoute?: string
}

/**
 * Optional Fastify plugin that decorates `app.buildGatewayManifest()` and
 * (optionally) exposes the manifest over HTTP.
 *
 * @example
 * ```ts
 * await app.register(fastifyGatewayPlugin, {
 *   context,
 *   defaults: { service: 'users-api' },
 * })
 *
 * // From anywhere in the app:
 * const manifest = app.buildGatewayManifest()
 *
 * // Or fetched over HTTP (default route):
 * //   GET /_gateway/manifest
 * ```
 */
const fastifyGatewayPluginInner: FastifyPluginCallback<FastifyGatewayPluginOptions> = (
  app: FastifyInstance,
  opts,
  done,
) => {
  const buildManifest: BuildGatewayManifestFn = (overrides) =>
    opts.context.buildGatewayManifest({ ...opts.defaults, ...(overrides ?? {}) })
  app.decorate('buildGatewayManifest', buildManifest)

  if (typeof opts.exposeRoute === 'string' && opts.exposeRoute.length > 0) {
    app.route({
      method: 'GET',
      url: opts.exposeRoute,
      handler: async () => buildManifest(),
    })
  }
  done()
}

export const fastifyGatewayPlugin = fp(fastifyGatewayPluginInner, {
  name: '@opinionated-machine/gateway',
  fastify: '5.x',
})
