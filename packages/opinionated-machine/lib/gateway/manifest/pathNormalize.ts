/**
 * Convert a Fastify-style path to the canonical OpenAPI/RFC 6570 form used
 * by the manifest. The manifest emits OpenAPI-style paths so each generator
 * can translate to its own dialect (Envoy regex matchers, KrakenD `{var}`,
 * AWS `{proxy+}`).
 *
 * Supported Fastify shapes (find-my-way):
 *   - `:userId`            ordinary parameter
 *   - `:userId?`           optional parameter   (the `?` is for matching only;
 *                                                we drop it from the path text)
 *   - `:userId(regex)`     inline-constraint    (the `(regex)` is for matching
 *                                                only; we drop it)
 *   - `*`                  wildcard             → `{wildcard}`
 *
 * Examples:
 *   /users/:userId            → /users/{userId}
 *   /users/:userId/posts/:id  → /users/{userId}/posts/{id}
 *   /files/*                  → /files/{wildcard}
 *   /a/:id?                   → /a/{id}
 *   /items/:slug(\\w+)        → /items/{slug}
 */
export function normalizePath(fastifyPath: string): string {
  if (!fastifyPath.startsWith('/')) {
    throw new Error(`Path must start with "/": ${fastifyPath}`)
  }

  const segments = fastifyPath.split('/').map((segment) => {
    if (segment === '*') return '{wildcard}'
    if (!segment.startsWith(':')) return segment

    // Strip optional-marker (?) and inline-constraint suffix ((regex)) — both
    // are matching directives, not part of the parameter's identity. Only the
    // bare name lands in the manifest path.
    const rest = segment.slice(1)
    const name = rest.replace(/\?$/, '').replace(/\(.*\)$/s, '')
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Invalid path parameter name "${name}" in "${fastifyPath}"`)
    }
    return `{${name}}`
  })

  return segments.join('/')
}
