/**
 * Operation key marking an endpoint as internal in a generated document.
 *
 * Shared by `openApiVisibilityTransform` (which writes it) and
 * `stripInternalOperations` (which filters on it): the two only work together
 * as long as they agree on the key, so the default lives in one place.
 */
export const DEFAULT_INTERNAL_MARKER_KEY = 'x-internal'

const EXTENSION_KEY_PREFIX = 'x-'

/**
 * Reject a marker key that `@fastify/swagger` would silently drop.
 *
 * The plugin copies only `x-`-prefixed schema keys into the generated
 * operation object. A marker key without that prefix therefore never reaches
 * the document, which makes `stripInternalOperations` match nothing and
 * publish every internal operation as the public spec — a leak with no
 * failing signal anywhere. Failing at configuration time is the only place
 * this is still catchable.
 */
export function assertInternalMarkerKey(key: string, optionPath: string): void {
  if (key.startsWith(EXTENSION_KEY_PREFIX) && key.length > EXTENSION_KEY_PREFIX.length) return

  throw new Error(
    `${optionPath} must be an OpenAPI extension key starting with "${EXTENSION_KEY_PREFIX}" ` +
      `(received "${key}"). @fastify/swagger drops every other key, so the marker would never ` +
      'reach the document and stripInternalOperations would publish internal operations.',
  )
}
