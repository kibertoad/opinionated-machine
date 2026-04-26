import type { BuildResolver, BuildResolverOptions, Constructor, DisposableResolver } from 'awilix'
import { asFunction } from 'awilix'
import type { DependencyInjectionOptions } from '../DIContext.ts'

declare module 'awilix' {
  interface ResolverOptions<T> {
    /** Marks a resolver as an api controller (new ApiContract-based). */
    isApiController?: boolean
  }
}

export type ApiControllerModuleOptions = {
  /**
   * DI options passed from the module. Used to detect test mode so the
   * connection spy is enabled automatically when `isTestMode` is true.
   */
  diOptions?: DependencyInjectionOptions
  /**
   * Enable room support. When true, resolves `sseRoomBroadcaster` from the DI
   * cradle and passes it to the controller constructor so that `session.rooms`
   * operations are wired to the real `SSERoomManager`.
   *
   * Requires `sseRoomManager` and `sseRoomBroadcaster` to be registered in the
   * DI container before this controller is resolved.
   */
  rooms?: boolean
}

/**
 * Register an `AbstractApiController` subclass with the awilix DI container.
 *
 * The returned resolver does **not** set `isSSEController` or `isDualModeController`,
 * so `DIContext` routes it through the standard REST controller path and calls
 * `buildRoutes()` automatically during `registerRoutes()`.
 *
 * @example
 * ```typescript
 * // In a module's resolveControllers():
 * return {
 *   userController: asApiControllerClass(UserController),
 *   dashboardController: asApiControllerClass(DashboardController, { diOptions, rooms: true }),
 * }
 * ```
 */
export function asApiControllerClass<T = object>(
  Type: { prototype: T },
  moduleOptions?: ApiControllerModuleOptions,
  opts?: BuildResolverOptions<T>,
): BuildResolver<T> & DisposableResolver<T> {
  const Ctor = Type as unknown as Constructor<T>
  const enableRooms = moduleOptions?.rooms ?? false
  const enableConnectionSpy = moduleOptions?.diOptions?.isTestMode ?? false

  return asFunction(
    // biome-ignore lint/suspicious/noExplicitAny: Dynamic constructor invocation with cradle proxy
    (cradle: any) => {
      const sseConfig = {
        ...(enableRooms && { roomBroadcaster: cradle.sseRoomBroadcaster }),
        ...(enableConnectionSpy && { enableConnectionSpy: true }),
      }
      return new Ctor(cradle, Object.keys(sseConfig).length > 0 ? sseConfig : undefined)
    },
    {
      public: false,
      isApiController: true,
      ...opts,
      lifetime: 'SINGLETON',
    },
  )
}
