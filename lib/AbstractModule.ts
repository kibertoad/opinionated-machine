import type { Resolver } from 'awilix'
import type { DependencyInjectionOptions } from './DIContext.js'

declare module 'awilix' {
  // biome-ignore lint/correctness/noUnusedVariables: interface overrides must match exactly
  interface ResolverOptions<T> {
    entityType:
      | 'controller'
      | 'useCase'
      | 'service'
      | 'repository'
      | 'jobConsumer'
      | 'queueConsumer'
      | 'expendable'
      | 'infrastructure'
  }
}

export type MandatoryNameAndRegistrationPair<T> = {
  [U in keyof T]: Resolver<T[U]>
}

export abstract class AbstractModule<ModuleDependencies> {
  public abstract resolveDIConfig(
    options?: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<ModuleDependencies>
}
