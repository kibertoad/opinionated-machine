import type { RouteType } from '@lokalise/fastify-api-contracts'
import type { AwilixContainer, NameAndRegistrationPair, Resolver } from 'awilix'
import { AwilixManager } from 'awilix-manager'
import type { FastifyInstance, RouteOptions } from 'fastify'
import type { AbstractController } from './AbstractController.js'
import type { AbstractModule } from './AbstractModule.js'
import { mergeConfigAndDependencyOverrides, type NestedPartial } from './configUtils.js'
import type { ENABLE_ALL } from './diConfigUtils.js'
import type { AbstractSSEController } from './sse/AbstractSSEController.ts'
import type { AnySSERouteDefinition } from './sse/sseContracts.ts'
import { buildFastifySSERoute, type RegisterSSERoutesOptions } from './sse/sseRouteBuilder.ts'

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
  /**
   * Enable test mode features like SSE connection spying.
   * Only set to true in test environments.
   * @default false
   */
  isTestMode?: boolean
}

export class DIContext<
  Dependencies extends object,
  Config extends object,
  ExternalDependencies = undefined,
> {
  private readonly options: DependencyInjectionOptions
  public readonly awilixManager: AwilixManager
  public readonly diContainer: AwilixContainer<Dependencies>
  // biome-ignore lint/suspicious/noExplicitAny: all controllers are controllers
  private readonly controllerResolvers: Resolver<any>[]
  // SSE controller dependency names (resolved from container to preserve singletons)
  private readonly sseControllerNames: string[]
  private readonly appConfig: Config

  constructor(
    diContainer: AwilixContainer,
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
    this.controllerResolvers = []
    this.sseControllerNames = []
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
      this.controllerResolvers.push(
        ...(Object.values(module.resolveControllers()) as Resolver<unknown>[]),
      )

      // Collect SSE controller names (resolved from container to preserve singletons)
      const sseControllers = module.resolveSSEControllers()
      if (sseControllers && Object.keys(sseControllers).length > 0) {
        this.sseControllerNames.push(...Object.keys(sseControllers))
      }
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

    this.diContainer.register(targetDiConfig)

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
    for (const controllerResolver of this.controllerResolvers) {
      // biome-ignore lint/suspicious/noExplicitAny: any controller works here
      const controller: AbstractController<any> = controllerResolver.resolve(this.diContainer)
      const routes = controller.buildRoutes()
      for (const route of Object.values(routes)) {
        // Cast needed: GET/DELETE routes have body:undefined, POST/PATCH have body:unknown
        // The union is incompatible with app.route() due to handler contravariance
        app.route(route as RouteType)
      }
    }
  }

  /**
   * Check if any SSE controllers are registered.
   * Use this to conditionally call registerSSERoutes().
   */
  hasSSEControllers(): boolean {
    return this.sseControllerNames.length > 0
  }

  /**
   * Register SSE routes with the Fastify app.
   *
   * Must be called separately from registerRoutes().
   * Requires @fastify/sse plugin to be registered on the app.
   *
   * @param app - Fastify instance with @fastify/sse registered
   * @param options - Optional configuration for SSE routes
   *
   * @example
   * ```typescript
   * // Register @fastify/sse plugin first
   * await app.register(fastifySSE, { heartbeatInterval: 30000 })
   *
   * // Then register SSE routes
   * context.registerSSERoutes(app)
   * ```
   */
  registerSSERoutes(
    // biome-ignore lint/suspicious/noExplicitAny: Fastify instance types are complex
    app: FastifyInstance<any, any, any, any>,
    options?: RegisterSSERoutesOptions,
  ): void {
    if (!this.hasSSEControllers()) {
      return
    }

    for (const controllerName of this.sseControllerNames) {
      // Resolve from container to use the singleton instance
      const sseController: AbstractSSEController<Record<string, AnySSERouteDefinition>> =
        this.diContainer.resolve(controllerName)
      const sseRoutes = sseController.buildSSERoutes()

      for (const routeConfig of Object.values(sseRoutes)) {
        const route = buildFastifySSERoute(sseController, routeConfig)
        this.applySSERouteOptions(route, options)
        app.route(route)
      }
    }
  }

  private applySSERouteOptions(route: RouteOptions, options?: RegisterSSERoutesOptions): void {
    if (options?.preHandler) {
      this.applyPreHandlers(route, options.preHandler)
    }
    if (options?.rateLimit) {
      this.applyRateLimit(route, options.rateLimit)
    }
  }

  private applyPreHandlers(
    route: RouteOptions,
    globalPreHandler: RouteOptions['preHandler'],
  ): void {
    const existingPreHandler = route.preHandler
    if (!existingPreHandler) {
      route.preHandler = globalPreHandler
      return
    }
    // biome-ignore lint/suspicious/noExplicitAny: preHandler types are complex
    const handlers: any[] = Array.isArray(existingPreHandler)
      ? existingPreHandler
      : [existingPreHandler]
    // biome-ignore lint/suspicious/noExplicitAny: preHandler types are complex
    const globalHandlers: any[] = Array.isArray(globalPreHandler)
      ? globalPreHandler
      : [globalPreHandler]
    route.preHandler = [...globalHandlers, ...handlers]
  }

  private applyRateLimit(
    route: RouteOptions,
    rateLimit: NonNullable<RegisterSSERoutesOptions['rateLimit']>,
  ): void {
    // biome-ignore lint/suspicious/noExplicitAny: config types vary by plugins
    const routeWithConfig = route as RouteOptions & { config?: any }
    routeWithConfig.config = {
      ...(routeWithConfig.config || {}),
      rateLimit,
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
