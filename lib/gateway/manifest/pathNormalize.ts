/**
 * Convert a Fastify-style path (`:userId`, `:userId?`, `*`) to the canonical
 * OpenAPI/RFC 6570 form used by the manifest (`{userId}`, `{userId}` with the
 * caller marking it optional separately, `{wildcard}`).
 *
 * The manifest emits OpenAPI-style paths so each generator can translate to
 * its own dialect (Envoy regex matchers, KrakenD `{var}`, AWS `{proxy+}`).
 *
 * Examples:
 *   /users/:userId            → /users/{userId}
 *   /users/:userId/posts/:id  → /users/{userId}/posts/{id}
 *   /files/*                  → /files/{wildcard}
 *   /a/:id?                   → /a/{id}      (optional flag is dropped from path text)
 */
export function normalizePath(fastifyPath: string): string {
  if (!fastifyPath.startsWith('/')) {
    throw new Error(`Path must start with "/": ${fastifyPath}`)
  }

  const segments = fastifyPath.split('/').map((segment) => {
    if (segment === '*') return '{wildcard}'
    if (segment.startsWith(':')) {
      const name = segment.slice(1).replace(/\?$/, '')
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(`Invalid path parameter name "${name}" in "${fastifyPath}"`)
      }
      return `{${name}}`
    }
    return segment
  })

  return segments.join('/')
}
