import type { RouteType } from '@lokalise/fastify-api-contracts'
import type { AwilixContainer, NameAndRegistrationPair, Resolver } from 'awilix'
import { AwilixManager } from 'awilix-manager'
import type { FastifyInstance, RouteOptions } from 'fastify'
import { merge } from 'ts-deepmerge'
import type { AbstractController } from './AbstractController.js'
import type { AbstractModule } from './AbstractModule.js'
import { mergeConfigAndDependencyOverrides, type NestedPartial } from './configUtils.js'
import type { ENABLE_ALL } from './diConfigUtils.js'
import type { AbstractDualModeController } from './dualmode/AbstractDualModeController.js'
import type { AnyDualModeContractDefinition } from './dualmode/dualModeContracts.js'
import {
  buildFastifyRoute,
  type RegisterDualModeRoutesOptions,
  type RegisterSSERoutesOptions,
} from './routes/index.js'
import type { AbstractSSEController } from './sse/AbstractSSEController.js'
import type { AnySSEContractDefinition } from './sse/sseContracts.js'

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
   * Enable SSE test mode features like connection spying.
   * Only relevant for SSE controllers. Set to true in test environments.
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
  // Dual-mode controller dependency names (resolved from container to preserve singletons)
  private readonly dualModeControllerNames: string[]
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
    this.dualModeControllerNames = []
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

      for (const [name, resolver] of Object.entries(controllers)) {
        // @ts-expect-error isDualModeController is a custom property on the resolver
        if (resolver.isDualModeController) {
          // Dual-mode controller: register in DI container and track name for route registration
          this.dualModeControllerNames.push(name)
          // @ts-expect-error we can't really ensure type-safety here
          targetDiConfig[name] = resolver
          // @ts-expect-error isSSEController is a custom property on the resolver
        } else if (resolver.isSSEController) {
          // SSE controller: register in DI container and track name for route registration
          this.sseControllerNames.push(name)
          // @ts-expect-error we can't really ensure type-safety here
          targetDiConfig[name] = resolver
        } else {
          // REST controller: add resolver for route registration
          this.controllerResolvers.push(resolver as Resolver<unknown>)
        }
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
   * Check if any dual-mode controllers are registered.
   * Use this to conditionally call registerDualModeRoutes().
   */
  hasDualModeControllers(): boolean {
    return this.dualModeControllerNames.length > 0
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
      const sseController: AbstractSSEController<Record<string, AnySSEContractDefinition>> =
        this.diContainer.resolve(controllerName)
      const sseRoutes = sseController.buildSSERoutes()

      for (const routeConfig of Object.values(sseRoutes)) {
        const route = buildFastifyRoute(sseController, routeConfig)
        this.applySSERouteOptions(route, options)
        app.route(route)
      }
    }
  }

  /**
   * Register dual-mode routes with the Fastify app.
   *
   * Dual-mode routes handle both SSE streaming and JSON responses on the
   * same path, automatically branching based on the `Accept` header.
   *
   * Must be called separately from registerRoutes() and registerSSERoutes().
   * Requires @fastify/sse plugin to be registered on the app.
   *
   * @param app - Fastify instance with @fastify/sse registered
   * @param options - Optional configuration for dual-mode routes
   *
   * @example
   * ```typescript
   * // Register @fastify/sse plugin first
   * await app.register(fastifySSE, { heartbeatInterval: 30000 })
   *
   * // Then register dual-mode routes
   * context.registerDualModeRoutes(app)
   * ```
   */
  registerDualModeRoutes(
    // biome-ignore lint/suspicious/noExplicitAny: Fastify instance types are complex
    app: FastifyInstance<any, any, any, any>,
    options?: RegisterDualModeRoutesOptions,
  ): void {
    if (!this.hasDualModeControllers()) {
      return
    }

    for (const controllerName of this.dualModeControllerNames) {
      // Resolve from container to use the singleton instance
      const dualModeController: AbstractDualModeController<
        Record<string, AnyDualModeContractDefinition>
      > = this.diContainer.resolve(controllerName)
      const dualModeRoutes = dualModeController.buildDualModeRoutes()

      for (const routeConfig of Object.values(dualModeRoutes)) {
        const route = buildFastifyRoute(dualModeController, routeConfig)
        this.applyDualModeRouteOptions(route, options)
        app.route(route)
      }
    }
  }

  private applyDualModeRouteOptions(
    route: RouteOptions,
    options?: RegisterDualModeRoutesOptions,
  ): void {
    if (options?.preHandler) {
      this.applyPreHandlers(route, options.preHandler)
    }
    if (options?.rateLimit) {
      this.applyRateLimit(route, options.rateLimit)
    }
    // Apply SSE-specific options (heartbeatInterval, serializer) for SSE mode
    if (options?.heartbeatInterval !== undefined || options?.serializer !== undefined) {
      // biome-ignore lint/suspicious/noExplicitAny: config types vary by plugins
      const routeWithConfig = route as RouteOptions & { config?: any }
      routeWithConfig.config = merge(routeWithConfig.config || {}, {
        sse: {
          ...(options.heartbeatInterval !== undefined && {
            heartbeatInterval: options.heartbeatInterval,
          }),
          ...(options.serializer !== undefined && { serializer: options.serializer }),
        },
      })
    }
  }

  private applySSERouteOptions(route: RouteOptions, options?: RegisterSSERoutesOptions): void {
    if (options?.preHandler) {
      this.applyPreHandlers(route, options.preHandler)
    }
    if (options?.rateLimit) {
      this.applyRateLimit(route, options.rateLimit)
    }
    // Apply SSE-specific options (heartbeatInterval, serializer)
    if (options?.heartbeatInterval !== undefined || options?.serializer !== undefined) {
      // biome-ignore lint/suspicious/noExplicitAny: config types vary by plugins
      const routeWithConfig = route as RouteOptions & { config?: any }
      routeWithConfig.config = merge(routeWithConfig.config || {}, {
        sse: {
          ...(options.heartbeatInterval !== undefined && {
            heartbeatInterval: options.heartbeatInterval,
          }),
          ...(options.serializer !== undefined && { serializer: options.serializer }),
        },
      })
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
