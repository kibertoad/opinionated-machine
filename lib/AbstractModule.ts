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

  /**
   * Override to register REST and SSE controllers.
   * Returns empty object by default - no changes needed for modules without controllers.
   *
   * Controllers registered here are automatically added to the DI container.
   * SSE controllers (created with asSSEControllerClass) are automatically detected
   * and registered for SSE route handling.
   *
   * @param diOptions - DI options (use for test mode detection with asSSEControllerClass)
   *
   * @example
   * ```typescript
   * public resolveControllers(diOptions: DependencyInjectionOptions) {
   *   return {
   *     // REST controller
   *     usersController: asControllerClass(UsersController),
   *     // SSE controller (automatically detected via isSSEController flag)
   *     notificationsSSEController: asSSEControllerClass(NotificationsSSEController, { diOptions }),
   *   }
   * }
   * ```
   */
  public resolveControllers(
    _diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<unknown> {
    return {}
  }
}
