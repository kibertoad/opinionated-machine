import type { RoomNameResolver } from './types.js'

/**
 * Define a typed room name resolver.
 *
 * This is a lightweight utility that adds compile-time type safety to room names.
 * It ensures that the same resolver function is used consistently across controllers
 * and domain services, preventing typos and parameter mismatches.
 *
 * @template TParams - The parameters required to construct the room name
 * @param resolver - A function that takes typed params and returns a room name string
 * @returns The same resolver function, typed as `RoomNameResolver<TParams>`
 *
 * @example
 * ```typescript
 * // Define a typed room
 * const dashboardRoom = defineRoom<{ dashboardId: string }>(
 *   ({ dashboardId }) => `dashboard:${dashboardId}`,
 * )
 *
 * // Use in controller handler — params are type-checked
 * connection.rooms.join(dashboardRoom({ dashboardId: request.params.dashboardId }))
 *
 * // Use in domain service — same resolver, same type safety
 * await broadcaster.broadcastToRoom(
 *   dashboardRoom({ dashboardId }),
 *   'metricsUpdate',
 *   metrics,
 * )
 * ```
 */
export function defineRoom<TParams>(
  resolver: RoomNameResolver<TParams>,
): RoomNameResolver<TParams> {
  return resolver
}
