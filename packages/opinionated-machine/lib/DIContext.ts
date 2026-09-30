import type { AwilixContainer, NameAndRegistrationPair, Resolver } from 'awilix'
import { AwilixManager } from 'awilix-manager'
import type { FastifyInstance, FastifyReply, onRequestHookHandler, RouteOptions } from 'fastify'
import type { AbstractModule } from './AbstractModule.js'
import type { AbstractApiController } from './api-contracts/index.ts'
import { mergeConfigAndDependencyOverrides, type NestedPartial } from './configUtils.js'
import type { ENABLE_ALL } from './diConfigUtils.js'
import {
  type BuildGatewayManifestOptions,
  buildGatewayManifestFrom,
  type CollectedController,
  type GatewayManifest,
} from './gateway/index.js'

export type RegisterDependenciesParams<Dependencies, Config, ExternalDependencies> = {
  modules: readonly AbstractModule<unknown, ExternalDependencies>[]
  secondaryModules?: readonly AbstractModule<unknown, ExternalDependencies>[] // only public dependencies from secondary modules are injected
  dependencyOverrides?: NameAndRegistrationPair<Dependencies>
  configOverrides?: NestedPartial<Config>
  configDependencyId?: string // defaults to 'config'
}

export type DependencyInjectionOptions = {
  jobQueuesEnabled?: false | typeof ENABLE_ALL | string[]
  enqueuedJobWorkersEnabled?: false | typeof ENABLE_ALL | string[]
  messageQueueConsumersEnabled?: false | typeof ENABLE_ALL | string[]
  periodicJobsEnabled?: false | typeof ENABLE_ALL | string[]
}

export class DIContext<
  Dependencies extends object,
  Config extends object,
  ExternalDependencies = undefined,
> {
  private readonly options: DependencyInjectionOptions
  public readonly awilixManager: AwilixManager
  public readonly diContainer: AwilixContainer<Dependencies>
  // Controller dependency names (resolved from container to preserve singletons)
  private readonly apiControllerNames: string[]
  private readonly appConfig: Config
  // SSE streams still open, closed in preClose so they don't keep app.close() waiting
  private readonly openSSEReplies: Set<FastifyReply>
  private isSSECloseHookRegistered: boolean

  constructor(
    diContainer: AwilixContainer<Dependencies>,
    options: DependencyInjectionOptions,
    appConfig: Config,
    awilixManager?: AwilixManager,
  ) {
    this.options = options
    this.diContainer = diContainer
    this.appConfig = appConfig
    this.awilixManager =
      awilixManager ??
      new AwilixManager({
        asyncDispose: true,
        asyncInit: true,
        diContainer,
        eagerInject: true,
        strictBooleanEnforced: true,
      })
    this.apiControllerNames = []
    this.openSSEReplies = new Set()
    this.isSSECloseHookRegistered = false
  }

  private registerControllers(
    // biome-ignore lint/suspicious/noExplicitAny: controller resolver properties are duck-typed
    controllers: Record<string, any>,
    targetDiConfig: NameAndRegistrationPair<Dependencies>,
  ): void {
    for (const [name, resolver] of Object.entries(controllers)) {
      if (!resolver.isApiController) {
        throw new Error(
          `Controller "${name}" must be registered with asApiControllerClass(). Controllers extend AbstractApiController and declare their routes with buildApiRoute().`,
        )
      }
      this.apiControllerNames.push(name)
      // @ts-expect-error we can't really ensure type-safety here
      targetDiConfig[name] = resolver
    }
  }

  private registerModule(
    module: AbstractModule<unknown, ExternalDependencies>,
    targetDiConfig: NameAndRegistrationPair<Dependencies>,
    externalDependencies: ExternalDependencies,
    resolveControllers: boolean,
    isPrimaryModule: boolean,
  ) {
    const resolvedDIConfig = module.resolveDependencies(this.options, externalDependencies)

    for (const key in resolvedDIConfig) {
      // @ts-expect-error we can't really ensure type-safety here
      if (isPrimaryModule || resolvedDIConfig[key].public) {
        // @ts-expect-error we can't really ensure type-safety here
        targetDiConfig[key] = resolvedDIConfig[key]
      }
    }

    if (isPrimaryModule && resolveControllers) {
      const controllers = module.resolveControllers(this.options)

      this.registerControllers(controllers, targetDiConfig)
    }
  }

  registerDependencies(
    params: RegisterDependenciesParams<Dependencies, Config, ExternalDependencies>,
    externalDependencies: ExternalDependencies,
    resolveControllers = true,
  ): void {
    const mergedOverrides = mergeConfigAndDependencyOverrides(
      this.appConfig,
      params.configDependencyId ?? 'config',
      params.configOverrides,
      params.dependencyOverrides ?? {},
    )
    const targetDiConfig: NameAndRegistrationPair<Dependencies> = {}

    for (const primaryModule of params.modules) {
      this.registerModule(
        primaryModule,
        targetDiConfig,
        externalDependencies,
        resolveControllers,
        true,
      )
    }

    if (params.secondaryModules) {
      for (const secondaryModule of params.secondaryModules) {
        this.registerModule(
          secondaryModule,
          targetDiConfig,
          externalDependencies,
          resolveControllers,
          false,
        )
      }
    }

    this.diContainer.register(targetDiConfig as Record<string, Resolver<unknown>>)

    // append dependency overrides
    // @ts-expect-error FixMe check this later
    for (const [dependencyKey, _dependencyValue] of Object.entries(mergedOverrides)) {
      const dependencyValue = { ...(_dependencyValue as Resolver<unknown>) }

      // preserve lifetime from original resolver
      const originalResolver = this.diContainer.getRegistration(dependencyKey)
      // @ts-expect-error
      if (dependencyValue.lifetime !== originalResolver.lifetime) {
        // @ts-expect-error
        dependencyValue.lifetime = originalResolver.lifetime
      }

      this.diContainer.register(dependencyKey, dependencyValue)
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: we don't care about what instance we get here
  registerRoutes(app: FastifyInstance<any, any, any, any>): void {
    for (const controllerName of this.apiControllerNames) {
      // biome-ignore lint/suspicious/noExplicitAny: any api controllers works here
      const controller: AbstractApiController<any> = this.diContainer.resolve(controllerName)

      for (const route of Object.values(controller.routes)) {
        this.registerStreamingRouteShutdown(app, route)
        app.route(route)
      }
    }
  }

  /**
   * Build a vendor-neutral gateway manifest from all registered controllers.
   * Routes carrying gateway metadata (passed inline via
   * `buildApiRoute(..., { gatewayMetadata })` or attached via
   * `withGatewayMetadata()`) get that metadata merged with controller-level
   * `gatewayDefaults` and the `defaults` passed here. Routes without any
   * metadata still appear in the manifest with empty metadata.
   *
   * The returned object is JSON-serializable; pass it to a generator package
   * like `@opinionated-machine/gateway-envoy` or
   * `@opinionated-machine/gateway-krakend` to produce a config.
   *
   * SSE and dual-mode routes carry a `streaming: 'sse' | 'dual'` marker.
   *
   * @example
   * ```ts
   * const manifest = context.buildGatewayManifest({
   *   service: 'users-api',
   *   defaults: { cors: { origins: ['https://app.example.com'] } },
   * })
   * const envoy = renderEnvoyConfig(manifest, { listenPort: 8080, clusters: { 'users-service': { hosts: ['users:8081'] } } })
   * writeFileSync('envoy.yaml', envoy.yaml)
   * ```
   */
  buildGatewayManifest(options: BuildGatewayManifestOptions): GatewayManifest {
    const collected: CollectedController[] = this.apiControllerNames.map((name) => ({
      name,
      controller: this.diContainer.resolve(name),
    }))

    return buildGatewayManifestFrom(collected, options)
  }

  /**
   * Keep the route's SSE streams from holding `app.close()`.
   *
   * Fastify closes its HTTP server in an `onClose` hook that runs before any the app registers,
   * and the server waits for every open connection. An open keepAlive stream would hold
   * `app.close()` until the process is killed, and no `onClose` hook registered after it would
   * run, the DI container dispose included. A single `preClose` hook, which runs before the
   * server is closed:
   * - closes the keepAlive streams still open. autoClose streams are left to finish, like any
   *   in-flight request.
   * - closes idle keep-alive connections until the server has closed: a response that finishes
   *   during shutdown (such as one of those autoClose streams) would otherwise keep its socket,
   *   and the server, open until `keepAliveTimeout`.
   */
  private registerStreamingRouteShutdown(app: FastifyInstance, route: RouteOptions): void {
    // The option @fastify/sse reads, set by buildApiRoute on every route that can stream SSE
    if (!('sse' in route)) return

    const trackReply: onRequestHookHandler = (_request, reply, done) => {
      this.openSSEReplies.add(reply)
      reply.raw.once('close', () => this.openSSEReplies.delete(reply))
      done()
    }
    const existing = route.onRequest
    route.onRequest = existing
      ? [trackReply, ...(Array.isArray(existing) ? existing : [existing])]
      : trackReply

    if (!this.isSSECloseHookRegistered) {
      this.isSSECloseHookRegistered = true
      app.addHook('preClose', (done) => {
        for (const reply of this.openSSEReplies) {
          // keepAlive streams never end by themselves; autoClose ones are left to finish
          if (reply.sse?.shouldKeepAlive) reply.sse.close()
        }
        // A response that finishes once the server is closing still leaves its keep-alive
        // socket open, and server.close() waits for it
        if (app.server.listening) {
          const sweep = setInterval(() => app.server.closeIdleConnections(), 100).unref()
          app.server.once('close', () => clearInterval(sweep))
        }
        done()
      })
    }
  }

  async destroy() {
    await this.awilixManager.executeDispose()
    await this.diContainer.dispose()
  }

  async init() {
    await this.awilixManager.executeInit()
  }
}
