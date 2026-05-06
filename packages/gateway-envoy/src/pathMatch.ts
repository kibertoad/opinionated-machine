/**
 * Convert an OpenAPI-style path (`/users/{userId}`) to an Envoy
 * `safe_regex` pattern. Envoy doesn't natively support `{param}` segments —
 * each one becomes a non-slash regex capture so the route matches exactly the
 * same set of paths the contract intended.
 *
 * `{wildcard}` (the marker we emit for Fastify `*`) is rendered as `.*`.
 */
export function openApiPathToEnvoyRegex(path: string): string {
  if (!path.startsWith('/')) {
    throw new Error(`Path must start with "/": ${path}`)
  }
  return path
    .split('/')
    .map((segment) => {
      if (segment === '{wildcard}') return '.*'
      const param = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(segment)
      if (param) return '[^/]+'
      return escapeRegex(segment)
    })
    .join('/')
}

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
