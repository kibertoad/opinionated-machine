import type { FastifyReply, FastifyRequest } from 'fastify'

/**
 * Key under `route.config` where the framework stores SSE runtime settings
 * applied at registration time (DIContext.registerSSERoutes /
 * registerDualModeRoutes). Route-level options passed to buildHandler /
 * buildApiRoute are captured in handler closures instead and take precedence.
 */
export const SSE_ROUTE_CONFIG_KEY = 'opinionatedSse' as const

/**
 * SSE runtime settings stored under `route.config[SSE_ROUTE_CONFIG_KEY]`.
 */
export type SSERouteRuntimeConfig = {
  /** Heartbeat interval in ms, or `0`/`false` to disable heartbeats. */
  heartbeatInterval?: number | false
}

function readSSERouteRuntimeConfig(request: FastifyRequest): SSERouteRuntimeConfig | undefined {
  const config = request.routeOptions?.config as unknown as Record<string, unknown> | undefined
  return config?.[SSE_ROUTE_CONFIG_KEY] as SSERouteRuntimeConfig | undefined
}

/**
 * Resolve the effective framework heartbeat interval for a request.
 *
 * Precedence: route-level option (from buildHandler / buildApiRoute) over
 * registration-time option (from route.config). Returns `undefined` when no
 * framework heartbeat should run — either nothing is configured (the plugin
 * default applies) or heartbeats are explicitly disabled (`0`/`false`).
 */
export function resolveHeartbeatInterval(
  routeLevel: number | false | undefined,
  request: FastifyRequest,
): number | undefined {
  const effective =
    routeLevel !== undefined ? routeLevel : readSSERouteRuntimeConfig(request)?.heartbeatInterval
  if (typeof effective !== 'number' || effective <= 0) {
    return undefined
  }
  return effective
}

/**
 * Start a framework-managed heartbeat, writing `: heartbeat\n\n` comment
 * frames on an interval. Must only be called after the SSE headers have been
 * sent. The timer is unref'd and self-stops when the response ends.
 *
 * @returns a stop function (idempotent)
 */
export function startFrameworkHeartbeat(reply: FastifyReply, intervalMs: number): () => void {
  const raw = reply.raw
  const timer = setInterval(() => {
    if (raw.writableEnded || raw.destroyed) {
      clearInterval(timer)
      return
    }
    try {
      raw.write(': heartbeat\n\n')
    } catch {
      clearInterval(timer)
    }
  }, intervalMs)
  timer.unref()

  return () => clearInterval(timer)
}
