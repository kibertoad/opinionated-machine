/**
 * Minimal structural view of an OpenAPI document. Deliberately loose: the
 * filtering below only needs `paths`, `tags` and `components.schemas`, and
 * typing the rest would force a dependency on `openapi-types`.
 */
export type OpenApiDocumentLike = {
  paths?: Record<string, Record<string, unknown> | undefined>
  tags?: Array<{ name?: string } & Record<string, unknown>>
  components?: { schemas?: Record<string, unknown> } & Record<string, unknown>
} & Record<string, unknown>

export type StripInternalOperationsOptions = {
  /**
   * Operation key that marks an internal endpoint. Must match the
   * `internalMarkerKey` used by `openApiVisibilityTransform`.
   *
   * @default 'x-internal'
   */
  markerKey?: string

  /**
   * Drop `components.schemas` entries and top-level `tags` entries that are no
   * longer referenced once the internal operations are gone.
   *
   * Leave this on unless the document intentionally publishes schemas no
   * operation references: internal request/response shapes reaching
   * `components.schemas` is exactly the leak this function exists to prevent.
   *
   * @default true
   */
  prune?: boolean
}

const DEFAULT_MARKER_KEY = 'x-internal'
const COMPONENT_SCHEMA_REF_PREFIX = '#/components/schemas/'
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

function collectRefs(value: unknown, acc: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, acc)
    return
  }
  if (typeof value !== 'object' || value === null) return

  for (const [key, nested] of Object.entries(value)) {
    if (key === '$ref' && typeof nested === 'string') {
      acc.add(nested)
      continue
    }
    collectRefs(nested, acc)
  }
}

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
 * Resolve which `components.schemas` entries are still reachable, following
 * `$ref`s transitively so a schema referenced only by another kept schema
 * survives.
 */
function resolveReachableSchemas(
  document: OpenApiDocumentLike,
  schemas: Record<string, unknown>,
): Set<string> {
  const { components: _components, ...documentWithoutComponents } = document
  const pending = new Set<string>()
  collectRefs(documentWithoutComponents, pending)

  const reachable = new Set<string>()
  const queue = [...pending]
  while (queue.length > 0) {
    const ref = queue.pop() as string
    if (!ref.startsWith(COMPONENT_SCHEMA_REF_PREFIX)) continue
    const name = ref.slice(COMPONENT_SCHEMA_REF_PREFIX.length)
    if (reachable.has(name) || !(name in schemas)) continue
    reachable.add(name)

    const nestedRefs = new Set<string>()
    collectRefs(schemas[name], nestedRefs)
    queue.push(...nestedRefs)
  }

  return reachable
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
 * Prefer this when the swagger instance is already wired to something else
 * (`@fastify/swagger-ui`, a static export step) and registering the plugin a
 * second time is awkward. Prefer two registrations when the two documents
 * should differ in more than their operation set (title, servers, security).
 *
 * The input document is never mutated — `app.swagger()` hands back a cached
 * object that must stay intact for the internal document.
 *
 * @example
 * ```ts
 * const internalDocument = app.swagger()
 * const publicDocument = stripInternalOperations(internalDocument)
 * ```
 */
export function stripInternalOperations<Document extends OpenApiDocumentLike>(
  document: Document,
  options?: StripInternalOperationsOptions,
): Document {
  // `app.swagger()` hands back a cached object that must stay intact for the
  // internal document, so every edit below happens on a copy.
  const result = structuredClone(document)

  removeInternalOperations(result, options?.markerKey ?? DEFAULT_MARKER_KEY)

  if (options?.prune ?? true) {
    pruneComponentSchemas(result)
    pruneTags(result)
  }

  return result
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

function pruneComponentSchemas(document: OpenApiDocumentLike): void {
  const schemas = document.components?.schemas
  if (schemas === undefined) return

  const reachable = resolveReachableSchemas(document, schemas)
  for (const name of Object.keys(schemas)) {
    if (!reachable.has(name)) delete schemas[name]
  }

  if (Object.keys(schemas).length === 0 && document.components) {
    delete document.components.schemas
  }
}

function pruneTags(document: OpenApiDocumentLike): void {
  if (!Array.isArray(document.tags)) return

  const usedTags = new Set<string>()
  collectTagNames(document.paths, usedTags)
  document.tags = document.tags.filter((tag) => tag.name === undefined || usedTags.has(tag.name))
}
