/**
 * Convert an OpenAPI-style path to a Kong regex path. Kong accepts plain
 * prefix paths or regex paths prefixed with `~`. Since universal paths use
 * `{param}` segments, every path with at least one `{...}` segment becomes a
 * regex with named captures.
 *
 * Examples:
 *   /users               → /users                                (plain prefix)
 *   /users/{userId}      → ~/users/(?<userId>[^/]+)$
 *   /files/{wildcard}    → ~/files/.*
 */
export function openApiPathToKong(path: string): string {
  if (!path.startsWith('/')) {
    throw new Error(`Path must start with "/": ${path}`)
  }

  let hasParam = false
  const segments = path.split('/').map((segment) => {
    if (segment === '{wildcard}') {
      hasParam = true
      return '.*'
    }
    const param = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(segment)
    if (param) {
      hasParam = true
      return `(?<${param[1]}>[^/]+)`
    }
    return escapeRegex(segment)
  })

  if (!hasParam) return path
  return `~${segments.join('/')}$`
}

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
