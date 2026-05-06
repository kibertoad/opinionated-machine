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
   * If set, also exposes `GET <route>` returning the manifest as JSON.
   * Use case: CLIs that don't want to load TypeScript code can `curl` the
   * running app to fetch its manifest. Set to `false` to skip.
   * @default '/_gateway/manifest'
   */
  exposeRoute?: string | false
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

  const route = opts.exposeRoute === undefined ? '/_gateway/manifest' : opts.exposeRoute
  if (route !== false) {
    app.route({
      method: 'GET',
      url: route,
      handler: async () => buildManifest(),
    })
  }
  done()
}

export const fastifyGatewayPlugin = fp(fastifyGatewayPluginInner, {
  name: '@opinionated-machine/gateway',
  fastify: '5.x',
})
