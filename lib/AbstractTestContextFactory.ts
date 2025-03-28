import { type NameAndRegistrationPair, createContainer } from 'awilix'
import { merge } from 'ts-deepmerge'
import type { AbstractModule } from './AbstractModule.js'
import { DIContext, type DependencyInjectionOptions } from './DIContext.js'
import { asSingletonFunction } from './resolverFunctions.js'

type NestedPartial<T> = {
  [P in keyof T]?: NestedPartial<T[P]>
}

export type ConfigOverrides<Config> = NestedPartial<Config>

export type CreateTestContextParams<Dependencies, Config extends object> = {
  modules?: readonly AbstractModule<unknown>[]
  diOptions?: DependencyInjectionOptions
  dependencyOverrides?: NameAndRegistrationPair<Dependencies>
  configOverrides?: ConfigOverrides<Config>
}

export abstract class AbstractTestContextFactory<
  Dependencies extends object,
  ExternalDependencies,
  Config extends object,
> {
  private readonly externalDependencies: ExternalDependencies
  protected configDependencyId = 'config' // override in subclass if different
  private readonly allModules: readonly AbstractModule<unknown>[]

  constructor(
    externalDependencies: ExternalDependencies,
    allModules: readonly AbstractModule<unknown>[],
  ) {
    this.externalDependencies = externalDependencies
    this.allModules = allModules
  }

  resetExternalDependencies() {
    // Override if necessary
  }

  abstract resolveBaseAppConfig(): Config

  async createTestContext(
    params: CreateTestContextParams<Dependencies, Config> = {},
  ): Promise<DIContext<Dependencies, ExternalDependencies>> {
    const diContainer = createContainer({
      injectionMode: 'PROXY',
    })

    const context = new DIContext<Dependencies, ExternalDependencies>(
      diContainer,
      params.diOptions ?? {},
    )

    const dependencyOverrides = params.configOverrides
      ? ({
          ...params.dependencyOverrides,
          [this.configDependencyId]: asSingletonFunction(() => {
            // biome-ignore lint/style/noNonNullAssertion: there is a ternary condition above
            return merge(this.resolveBaseAppConfig(), params.configOverrides!)
          }),
        } as NameAndRegistrationPair<Dependencies>)
      : params.dependencyOverrides

    const modules = params.modules ?? this.allModules
    context.registerDependencies(
      {
        dependencyOverrides,
        modules,
      },
      this.externalDependencies,
      false,
    )

    await context.init()

    return context
  }
}
