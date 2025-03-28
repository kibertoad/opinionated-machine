import type { Resolver } from 'awilix'
import type { DependencyInjectionOptions } from './DIContext.js'

export type MandatoryNameAndRegistrationPair<T> = {
  [U in keyof T]: Resolver<T[U]>
}

export abstract class AbstractModule<ModuleDependencies, ExternalDependencies = never> {
  public abstract resolveDependencies(
    diOptions?: DependencyInjectionOptions,
    externalDependencies?: ExternalDependencies,
  ): MandatoryNameAndRegistrationPair<ModuleDependencies>

  public abstract resolveControllers(): MandatoryNameAndRegistrationPair<unknown>
}
