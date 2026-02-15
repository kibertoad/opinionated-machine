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
 * Infers only the **public** dependency types from the return type of `resolveDependencies()`,
 * omitting non-public dependencies entirely.
 *
 * When a module is used as a secondary module, only resolvers marked with `public: true`
 * (i.e. those created via `asServiceClass`, `asUseCaseClass`, `asJobQueueClass`, or
 * `asEnqueuedJobQueueManagerFunction`) are exposed. Non-public resolvers are filtered out.
 *
 * @example
 * ```typescript
 * export class MyModule extends AbstractModule {
 *   resolveDependencies(diOptions: DependencyInjectionOptions) {
 *     return {
 *       myService: asServiceClass(MyService),       // public → MyService
 *       myRepo: asRepositoryClass(MyRepository),     // private → omitted
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
 * Like {@link InferPublicModuleDependencies}, but retains **all** dependency keys:
 * public dependencies are mapped to their unwrapped types, while non-public ones
 * are mapped to `never`.
 *
 * Designed to be used as the type argument for {@link AvailableDependencies} so that
 * private dependencies from other modules stay inaccessible (`never` wins over the
 * permissive index signature) while same-module deps fall through to `any`.
 *
 * @example
 * ```typescript
 * // Inferred as { myService: MyService; myRepo: never }
 * type Deps = InferStrictPublicModuleDependencies<MyModule>
 *
 * // Use with AvailableDependencies in asSingletonFunction callbacks:
 * asSingletonFunction(
 *   ({ myService }: AvailableDependencies<Deps>): MyHelper => new MyHelper(myService),
 * )
 * ```
 */
export type InferStrictPublicModuleDependencies<M extends AbstractModule> =
  ReturnType<M['resolveDependencies']> extends infer R
    ? {
        [K in keyof R]: R[K] extends { readonly __publicResolver: true }
          ? R[K] extends Resolver<infer T>
            ? T
            : never
          : never
      }
    : never

/**
 * Merges known typed dependencies with a permissive index signature for
 * same-module references that cannot be explicitly typed without causing
 * circular self-reference.
 *
 * **Intended for `asSingletonFunction` callbacks** inside `resolveDependencies()`,
 * where the `ClassValue<T>` trick used by class-based resolvers is not available.
 * Prefer class-based resolvers (`asServiceClass`, `asSingletonClass`, etc.) wherever
 * possible — they provide full type safety with no `any` fallback.
 *
 * @example
 * ```typescript
 * // Cross-module deps are fully typed, same-module deps are `any`
 * myHelper: asSingletonFunction(
 *   ({ externalService, localDep }: AvailableDependencies<OtherModulePublicDeps>): MyHelper => {
 *     return new MyHelper(externalService, localDep)
 *   },
 * )
 * ```
 */
export type AvailableDependencies<
  // biome-ignore lint/complexity/noBannedTypes: empty default allows bare usage without type params
  KnownDeps extends Record<string, unknown> = {},
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
