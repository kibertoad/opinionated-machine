import type { AwilixContainer, NameAndRegistrationPair, Resolver } from 'awilix'
import { AwilixManager } from 'awilix-manager'
import type { FastifyInstance } from 'fastify'
import type { AbstractController } from './AbstractController.js'
import type { AbstractModule } from './AbstractModule.js'
import { mergeConfigAndDependencyOverrides, type NestedPartial } from './configUtils.js'
import type { ENABLE_ALL } from './diConfigUtils.js'

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
  // biome-ignore lint/suspicious/noExplicitAny: all controllers are controllers
  private readonly controllerResolvers: Resolver<any>[]
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
        app.route(route)
      }
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
