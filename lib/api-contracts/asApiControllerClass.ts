import type { BuildResolver, BuildResolverOptions, Constructor, DisposableResolver } from 'awilix'
import { asFunction } from 'awilix'

declare module 'awilix' {
  interface ResolverOptions<T> {
    /** Marks a resolver as an api controller (new ApiContract-based). */
    isApiController?: boolean
  }
}

/**
 * Register an `AbstractApiController` subclass with the awilix DI container.
 *
 * The returned resolver does **not** set `isSSEController` or `isDualModeController`,
 * so `DIContext` reads its `routes` property automatically during `registerRoutes()`.
 *
 * @example
 * ```typescript
 * // In a module's resolveControllers():
 * return {
 *   userController: asApiControllerClass(UserController),
 * }
 * ```
 */
export function asApiControllerClass<T = object>(
  Type: { prototype: T },
  opts?: BuildResolverOptions<T>,
): BuildResolver<T> & DisposableResolver<T> {
  const Ctor = Type as unknown as Constructor<T>
  return asFunction(
    // biome-ignore lint/suspicious/noExplicitAny: Dynamic constructor invocation with cradle proxy
    (cradle: any) => new Ctor(cradle),
    {
      public: false,
      isApiController: true,
      ...opts,
      lifetime: 'SINGLETON',
    },
  )
}
