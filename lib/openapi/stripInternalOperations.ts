import { type OpenApiDocumentLike, pruneComponentsInPlace } from './componentReachability.ts'
import { assertInternalMarkerKey, DEFAULT_INTERNAL_MARKER_KEY } from './internalMarker.ts'

export type { OpenApiDocumentLike }

export type StripInternalOperationsOptions = {
  /**
   * Operation key that marks an internal endpoint. Must match the
   * `internalMarkerKey` used by `openApiVisibilityTransform`, and must start
   * with `x-` — anything else is rejected, because `@fastify/swagger` would
   * never have written it to the document in the first place.
   *
   * @default 'x-internal'
   */
  markerKey?: string

  /**
   * Drop `components` entries and top-level `tags` entries that are no longer
   * referenced once the internal operations are gone.
   *
   * Leave this on unless the document intentionally publishes components no
   * operation references: internal request/response shapes reaching
   * `components` is exactly the leak this function exists to prevent.
   *
   * @default true
   */
  prune?: boolean
}

const HTTP_OPERATION_KEYS = new Set([
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
])

function operationEntries(
  pathItem: Record<string, unknown> | undefined,
): Array<[string, Record<string, unknown> | undefined]> {
  return Object.entries(pathItem ?? {}).filter(([key]) => HTTP_OPERATION_KEYS.has(key)) as Array<
    [string, Record<string, unknown> | undefined]
  >
}

function collectTagNames(paths: OpenApiDocumentLike['paths'], acc: Set<string>): void {
  for (const pathItem of Object.values(paths ?? {})) {
    for (const [, operation] of operationEntries(pathItem)) {
      const tags = operation?.tags
      if (!Array.isArray(tags)) continue
      for (const tag of tags) {
        if (typeof tag === 'string') acc.add(tag)
      }
    }
  }
}

/**
 * Derive the public OpenAPI document from an internal one by removing every
 * operation marked as internal.
 *
 * The alternative to registering `@fastify/swagger` twice: generate a single
 * document with `openApiVisibilityTransform({ audience: 'internal' })` — which
 * marks internal operations with `x-internal: true` — and run it through this
 * function to get the customer-facing version. One route table, one schema
 * pass, two documents.
 *
 * Prefer this when the swagger instance is already wired to something else (a
 * static export step, a UI that cannot be pointed at a second document) and
 * registering the plugin a second time is awkward. Prefer two registrations
 * when the two documents should differ in more than their operation set
 * (title, servers, security).
 *
 * The input document is never mutated — `app.swagger()` hands back a cached
 * object that must stay intact for the internal document. *
 * The type parameter is deliberately unconstrained. `openapi-types`' `Document`
 * interfaces have no index signatures, so they do not structurally satisfy
 * {@link OpenApiDocumentLike} even though they are exactly what this is for —
 * constraining it would reject `app.swagger()`, the only argument that matters.
 * The document is inspected defensively at runtime instead.
 *
 * @example
 * ```ts
 * const internalDocument = app.swagger()
 * const publicDocument = stripInternalOperations(internalDocument)
 * ```
 */
export function stripInternalOperations<Document>(
  document: Document,
  options?: StripInternalOperationsOptions,
): Document {
  const markerKey = options?.markerKey ?? DEFAULT_INTERNAL_MARKER_KEY
  assertInternalMarkerKey(markerKey, 'stripInternalOperations: `markerKey`')

  // `app.swagger()` hands back a cached object that must stay intact for the
  // internal document, so every edit below happens on a copy.
  const result = structuredClone(document) as OpenApiDocumentLike

  removeInternalOperations(result, markerKey)

  if (options?.prune ?? true) {
    pruneComponentsInPlace(result)
    pruneTags(result)
  }

  return result as Document
}

function removeInternalOperations(document: OpenApiDocumentLike, markerKey: string): void {
  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    if (pathItem === undefined) continue

    for (const [key, operation] of operationEntries(pathItem)) {
      if (operation?.[markerKey] === true) delete pathItem[key]
    }

    if (operationEntries(pathItem).length === 0 && document.paths) {
      delete document.paths[path]
    }
  }
}

function pruneTags(document: OpenApiDocumentLike): void {
  if (!Array.isArray(document.tags)) return

  const usedTags = new Set<string>()
  collectTagNames(document.paths, usedTags)
  document.tags = document.tags.filter((tag) => tag.name === undefined || usedTags.has(tag.name))
}
