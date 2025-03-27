import type { AwilixContainer, NameAndRegistrationPair, Resolver } from 'awilix'
import { AwilixManager } from 'awilix-manager'
import type { FastifyInstance } from 'fastify'
import type { AbstractController } from './AbstractController.js'
import type { AbstractModule } from './AbstractModule.js'

export type registerDependenciesParams<Dependencies> = {
  modules: readonly AbstractModule<unknown>[]
  dependencyOverrides?: NameAndRegistrationPair<Dependencies>
}

export type DependencyInjectionOptions = {
  enqueuedJobQueuesEnabled?: boolean | string[]
  enqueuedJobProcessorsEnabled?: boolean | string[]
  messageQueueConsumersEnabled?: boolean | string[]
  periodicJobsEnabled?: boolean
}

const SINGLETON_LIFECYCLE = 'SINGLETON'
const TRANSIENT_LIFECYCLE = 'TRANSIENT'

export const ENTITY_TYPES = {
  EXPENDABLE: 'expendable',
  CONTROLLER: 'controller',
}

export class DIContext<Dependencies extends object> {
  private readonly options: DependencyInjectionOptions
  public readonly awilixManager: AwilixManager
  public readonly diContainer: AwilixContainer<Dependencies>
  // biome-ignore lint/suspicious/noExplicitAny: all controllers are controllers
  private readonly controllerResolvers: Resolver<any>[]

  constructor(diContainer: AwilixContainer, options: DependencyInjectionOptions) {
    this.options = options
    this.diContainer = diContainer
    this.awilixManager = new AwilixManager({
      asyncDispose: true,
      asyncInit: true,
      diContainer,
      eagerInject: true,
      strictBooleanEnforced: true,
    })
    this.controllerResolvers = []
  }

  private static preprocessResolver(entry: Resolver<unknown>, name: string): void {
    if (!entry.entityType) {
      throw new Error(`entityType param is missing for resolver ${name}`)
    }

    // default non-expendable entries to singletons
    if (entry.lifetime === TRANSIENT_LIFECYCLE && entry.entityType !== ENTITY_TYPES.EXPENDABLE) {
      entry.lifetime = SINGLETON_LIFECYCLE
    }
  }

  registerDependencies(params: registerDependenciesParams<Dependencies>): void {
    const _dependencyOverrides = params.dependencyOverrides ?? {}
    const diConfig: NameAndRegistrationPair<Dependencies> = {}

    for (const module of params.modules) {
      const resolvedDIConfig = module.resolveDIConfig(this.options)

      for (const key in resolvedDIConfig) {
        // @ts-expect-error we can't really ensure type-safety here
        diConfig[key] = resolvedDIConfig[key]

        // @ts-expect-error we can't really ensure type-safety here
        const currentEntry: Resolver<unknown> = diConfig[key]
        DIContext.preprocessResolver(currentEntry, key)
      }

      this.controllerResolvers.push(...Object.values(module.resolveControllers()))
    }
    this.diContainer.register(diConfig)

    for (const [dependencyKey, _dependencyValue] of Object.entries(_dependencyOverrides)) {
      const dependencyValue = { ...(_dependencyValue as Resolver<unknown>) }

      // preserve entityType and lifetime from original resolver
      const originalResolver = this.diContainer.getRegistration(dependencyKey)
      if (!dependencyValue.entityType) {
        // @ts-ignore
        dependencyValue.entityType = originalResolver.entityType
      }
      // @ts-ignore
      if (dependencyValue.lifetime !== originalResolver.lifetime) {
        // @ts-ignore
        dependencyValue.lifetime = originalResolver.lifetime
      }

      DIContext.preprocessResolver(dependencyValue, dependencyKey)
      this.diContainer.register(dependencyKey, dependencyValue)
    }
  }

  registerRoutes(app: FastifyInstance): void {
    for (const controllerResolver of this.controllerResolvers) {
      // biome-ignore lint/suspicious/noExplicitAny: any controller works here
      const controller: AbstractController<any> = controllerResolver.resolve(this.diContainer)
      const routes = controller.buildRoutes()
      for (const route of Object.values(routes)) {
        app.route(route)
      }
    }
  }
}
