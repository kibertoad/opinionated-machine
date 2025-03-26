import { type AwilixContainer, Lifetime, type NameAndRegistrationPair, type Resolver } from 'awilix'
import { AwilixManager } from 'awilix-manager'
import type { FastifyInstance } from 'fastify'
import type { AbstractModule } from './AbstractModule.js'

export const SINGLETON_CONFIG = { lifetime: Lifetime.SINGLETON }

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
  }

  private static preprocessResolver(entry: Resolver<unknown>, name: string): void {
    if (!entry.entityType) {
      throw new Error(`entityType param is missing for resolver ${name}`)
    }

    // default non-expendable entries to singletons
    if (entry.lifetime === TRANSIENT_LIFECYCLE && entry.entityType !== ENTITY_TYPES.EXPENDABLE) {
      entry.lifetime = SINGLETON_LIFECYCLE
    }

    if (entry.entityType === ENTITY_TYPES.CONTROLLER) {
      if (!entry.tags) {
        entry.tags = [ENTITY_TYPES.CONTROLLER]
      } else {
        entry.tags.push(ENTITY_TYPES.CONTROLLER)
      }
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
    const controllers = this.awilixManager.getWithTags(['controller'])
    for (const route of routes) {
      app.route(route)
    }
  }
}
