import { type AwilixContainer, Lifetime, type NameAndRegistrationPair, type Resolver } from 'awilix'
import type { AbstractModule } from './AbstractModule.js'

export const SINGLETON_CONFIG = { lifetime: Lifetime.SINGLETON }

export type registerDependenciesParams<Dependencies> = {
  modules: readonly AbstractModule<unknown>[]
  dependencyOverrides?: Partial<NameAndRegistrationPair<Dependencies>>
}

export type DependencyInjectionOptions = {
  enqueuedJobQueuesEnabled?: boolean | string[]
  enqueuedJobProcessorsEnabled?: boolean | string[]
  messageQueueConsumersEnabled?: boolean | string[]
  periodicJobsEnabled?: boolean
}

export class DIContext<Dependencies extends object> {
  private readonly options: DependencyInjectionOptions
  public readonly diContainer: AwilixContainer<Dependencies>

  constructor(diContainer: AwilixContainer, options: DependencyInjectionOptions) {
    this.options = options
    this.diContainer = diContainer
  }

  registerDependencies(params: registerDependenciesParams<Dependencies>): void {
    const _dependencyOverrides = params.dependencyOverrides ?? {}
    const diConfig: NameAndRegistrationPair<Dependencies> = {}

    for (const module of params.modules) {
      const resolvedDIConfig = module.resolveDIConfig(this.options)

      for (const key in resolvedDIConfig) {
        // @ts-expect-error we can't really ensure type-safety here
        diConfig[key] = resolvedDIConfig[key]
      }
    }
    this.diContainer.register(diConfig)

    for (const [dependencyKey, dependencyValue] of Object.entries(_dependencyOverrides)) {
      this.diContainer.register(dependencyKey, dependencyValue as Resolver<unknown>)
    }
  }
}
