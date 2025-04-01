import { type AwilixContainer, type NameAndRegistrationPair, createContainer } from 'awilix'
import type { AbstractModule } from './AbstractModule.js'
import { DIContext, type DependencyInjectionOptions } from './DIContext.js'
import type { NestedPartial } from './configUtils.js'

export type CreateTestContextParams<Dependencies, Config extends object> = {
  modules?: readonly AbstractModule<unknown>[]
  secondaryModules?: readonly AbstractModule<unknown>[] // only public dependencies from secondary modules are injected
  diOptions?: DependencyInjectionOptions
  dependencyOverrides?: NameAndRegistrationPair<Dependencies>
  configOverrides?: NestedPartial<Config>
}

export abstract class AbstractTestContextFactory<
  Dependencies extends object,
  ExternalDependencies,
  Config extends object,
> {
  public diContainer: AwilixContainer<Dependencies>
  private readonly externalDependencies: ExternalDependencies
  protected configDependencyId = 'config' // override in subclass if different
  private readonly allModules: readonly AbstractModule<unknown>[]

  constructor(
    externalDependencies: ExternalDependencies,
    allModules: readonly AbstractModule<unknown>[],
    diContainer?: AwilixContainer,
  ) {
    this.externalDependencies = externalDependencies
    this.allModules = allModules
    this.diContainer =
      diContainer ??
      createContainer({
        injectionMode: 'PROXY',
      })
  }

  resetExternalDependencies() {
    // Override if necessary
  }

  abstract resolveBaseAppConfig(): Config

  async createTestContext(
    params: CreateTestContextParams<Dependencies, Config> = {},
  ): Promise<DIContext<Dependencies, Config, ExternalDependencies>> {
    const context = new DIContext<Dependencies, Config, ExternalDependencies>(
      this.diContainer,
      params.diOptions ?? {},
      this.resolveBaseAppConfig(),
    )

    const modules = params.modules ?? this.allModules
    context.registerDependencies(
      {
        dependencyOverrides: params.dependencyOverrides,
        configOverrides: params.configOverrides,
        modules,
        secondaryModules: params.secondaryModules,
        configDependencyId: this.configDependencyId,
      },
      this.externalDependencies,
      false,
    )

    await context.init()

    return context
  }
}
