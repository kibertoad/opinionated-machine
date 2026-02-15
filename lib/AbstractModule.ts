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

/**
 * Infers the module's dependency types from the return type of `resolveDependencies()`.
 *
 * This eliminates the need to manually define a `ModuleDependencies` type that duplicates
 * information already present in the resolver return value.
 *
 * @example
 * ```typescript
 * export class MyModule extends AbstractModule {
 *   resolveDependencies(diOptions: DependencyInjectionOptions) {
 *     return {
 *       myService: asServiceClass(MyService),
 *       myRepo: asRepositoryClass(MyRepository),
 *     }
 *   }
 * }
 *
 * // Inferred as { myService: MyService; myRepo: MyRepository }
 * export type MyModuleDependencies = InferModuleDependencies<MyModule>
 * ```
 */
export type InferModuleDependencies<M extends AbstractModule> =
  ReturnType<M['resolveDependencies']> extends infer R
    ? { [K in keyof R]: R[K] extends Resolver<infer T> ? T : never }
    : never

/**
 * Infers only the **public** dependency types from the return type of `resolveDependencies()`.
 *
 * When a module is used as a secondary module, only resolvers marked with `public: true`
 * (i.e. those created via `asServiceClass`, `asUseCaseClass`, `asJobQueueClass`, or
 * `asEnqueuedJobQueueManagerFunction`) are exposed. This type automatically filters
 * to just those public dependencies.
 *
 * @example
 * ```typescript
 * export class MyModule extends AbstractModule {
 *   resolveDependencies(diOptions: DependencyInjectionOptions) {
 *     return {
 *       myService: asServiceClass(MyService),       // public
 *       myRepo: asRepositoryClass(MyRepository),     // private
 *     }
 *   }
 * }
 *
 * // Inferred as { myService: MyService }
 * export type MyModulePublicDependencies = InferPublicModuleDependencies<MyModule>
 * ```
 */
export type InferPublicModuleDependencies<M extends AbstractModule> =
  ReturnType<M['resolveDependencies']> extends infer R
    ? {
        [K in keyof R as R[K] extends { readonly __publicResolver: true }
          ? K
          : never]: R[K] extends Resolver<infer T> ? T : never
      }
    : never

/**
 * Utility type for typing the cradle parameter in any DI-managed construction — whether
 * via `asClass` (constructor injection) or `asFunction` callbacks.
 *
 * Merges all known external public dependencies (which are safe from circular references)
 * with a permissive index signature for in-module references. This gives autocompletion
 * and type safety for cross-module deps, while allowing freeform access to same-module
 * deps that cannot be explicitly typed without circular self-reference.
 *
 * @example
 * ```typescript
 * // In a class constructor — otherModuleService is typed, localDep is accessible without error
 * export class MyService {
 *   constructor({ otherModuleService, localDep }: AvailableDependencies<OtherModulePublicDeps>) { ... }
 * }
 *
 * // In an asFunction callback — same pattern
 * myFn: asFunction(({ otherModuleService, localDep }: AvailableDependencies<OtherModulePublicDeps>) => { ... })
 * ```
 *
 * @see README.md for an alternative pattern using `InferCradleFromResolvers` for full type safety.
 */
export type AvailableDependencies<
  KnownDeps extends Record<string, unknown> = Record<string, unknown>,
> =
  // biome-ignore lint/suspicious/noExplicitAny: permissive index signature for unknown local deps
  KnownDeps & Record<string, any>

export abstract class AbstractModule<ModuleDependencies = unknown, ExternalDependencies = never> {
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
