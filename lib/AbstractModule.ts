import type { Resolver } from 'awilix'
import type { DependencyInjectionOptions } from './DIContext.js'

export type MandatoryNameAndRegistrationPair<T> = {
  [U in keyof T]: Resolver<T[U]>
}

export abstract class AbstractModule<ModuleDependencies> {
  public abstract resolveDIConfig(
    options?: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<ModuleDependencies>

  public abstract resolveControllers(): // biome-ignore lint/suspicious/noExplicitAny: we allow any controllers
  MandatoryNameAndRegistrationPair<any>
}
