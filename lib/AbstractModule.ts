import type { Resolver } from 'awilix'
import type { DependencyInjectionOptions } from './DIContext.js'

export type MandatoryNameAndRegistrationPair<T> = {
  [U in keyof T]: Resolver<T[U]>
}

/**
 * Use this utility type to combine dependencies from multiple modules into full context list of dependencies
 */
export type UnionToIntersection<U> =
  // biome-ignore lint/suspicious/noExplicitAny: we accept anything here
  (U extends any ? (x: U) => void : never) extends (x: infer I) => void ? I : never

export abstract class AbstractModule<ModuleDependencies, ExternalDependencies = never> {
  public abstract resolveDependencies(
    diOptions: DependencyInjectionOptions,
    externalDependencies: ExternalDependencies,
  ): MandatoryNameAndRegistrationPair<ModuleDependencies>

  public abstract resolveControllers(): MandatoryNameAndRegistrationPair<unknown>

  /**
   * Override to register SSE controllers.
   * Returns empty object by default - no changes needed for modules without SSE.
   *
   * SSE controllers registered here are automatically added to the DI container,
   * so you don't need to also register them in resolveDependencies().
   *
   * @param diOptions - DI options (use for test mode detection with asSSEControllerClass)
   *
   * @example
   * ```typescript
   * public resolveSSEControllers(diOptions: DependencyInjectionOptions) {
   *   return {
   *     notificationsSSEController: asSSEControllerClass(NotificationsSSEController, { diOptions }),
   *   }
   * }
   * ```
   */
  public resolveSSEControllers(
    _diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<unknown> {
    return {}
  }
}
