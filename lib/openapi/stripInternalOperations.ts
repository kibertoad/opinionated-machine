import { assertInternalMarkerKey, DEFAULT_INTERNAL_MARKER_KEY } from './internalMarker.ts'

/**
 * Minimal structural view of an OpenAPI document. Deliberately loose: the
 * filtering below only needs `paths`, `tags` and `components`, and typing the
 * rest would force a dependency on `openapi-types`.
 */
export type OpenApiDocumentLike = {
  paths?: Record<string, Record<string, unknown> | undefined>
  tags?: Array<{ name?: string } & Record<string, unknown>>
  components?: { schemas?: Record<string, unknown> } & Record<string, unknown>
} & Record<string, unknown>

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

const COMPONENTS_REF_PREFIX = '#/components/'
const COMPONENT_SCHEMA_REF_PREFIX = `${COMPONENTS_REF_PREFIX}schemas/`

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

/**
 * Component sections pruned when nothing reachable references them.
 *
 * `securitySchemes` is deliberately absent: security schemes are referenced by
 * name from `security` requirements rather than by `$ref`, so reachability
 * says nothing about whether they are still needed. Any section not listed
 * here is likewise left alone — and, since it survives, counts as a root for
 * everything it references.
 */
const PRUNABLE_COMPONENT_SECTIONS = new Set([
  'schemas',
  'responses',
  'parameters',
  'examples',
  'requestBodies',
  'headers',
  'links',
  'callbacks',
  'pathItems',
])

/**
 * `discriminator.mapping` points at schemas with bare strings instead of
 * `$ref` objects, so a schema reachable only through a mapping would be pruned
 * and leave the discriminator dangling.
 *
 * A real Discriminator Object always carries `propertyName`, which is what
 * distinguishes it from a schema property that happens to be named
 * `discriminator`. Returns whether the value was one.
 */
function collectDiscriminatorRefs(value: unknown, acc: Set<string>): boolean {
  if (typeof value !== 'object' || value === null) return false

  const { propertyName, mapping } = value as { propertyName?: unknown; mapping?: unknown }
  if (typeof propertyName !== 'string') return false

  if (typeof mapping === 'object' && mapping !== null) {
    for (const target of Object.values(mapping)) {
      if (typeof target !== 'string') continue
      // A mapping value is either an explicit reference or a schema name.
      acc.add(target.startsWith('#/') ? target : `${COMPONENT_SCHEMA_REF_PREFIX}${target}`)
    }
  }

  return true
}

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
    if (key === 'discriminator' && collectDiscriminatorRefs(nested, acc)) continue
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
 * Seed the reachability walk.
 *
 * Everything outside `components` is a root, and so is every component section
 * that is never pruned: those survive unconditionally, so whatever they point
 * at has to survive with them. Missing this second group is how a
 * `components.schemas` entry referenced only from, say, a kept
 * `components.responses` entry gets pruned out from under a live `$ref`.
 */
function collectRootRefs(document: OpenApiDocumentLike, acc: Set<string>): void {
  const { components, ...documentWithoutComponents } = document
  collectRefs(documentWithoutComponents, acc)

  for (const [section, entries] of Object.entries(components ?? {})) {
    if (PRUNABLE_COMPONENT_SECTIONS.has(section)) continue
    collectRefs(entries, acc)
  }
}

/** `section/name` of a component entry, the key reachability is tracked by. */
type ComponentId = string

function parseComponentRef(ref: string): ComponentId | undefined {
  if (!ref.startsWith(COMPONENTS_REF_PREFIX)) return undefined

  // Component keys are restricted to `[a-zA-Z0-9._-]`, so no JSON-pointer
  // escaping can appear here. Segments past the entry name (`.../Foo/items`)
  // point *into* a component, which still requires keeping the component.
  const [section, name] = ref.slice(COMPONENTS_REF_PREFIX.length).split('/')
  if (section === undefined || name === undefined || name === '') return undefined
  if (!PRUNABLE_COMPONENT_SECTIONS.has(section)) return undefined

  return `${section}/${name}`
}

function readComponent(
  components: Record<string, unknown>,
  id: ComponentId,
): { entries: Record<string, unknown>; name: string } | undefined {
  const separator = id.indexOf('/')
  const entries = components[id.slice(0, separator)]
  if (typeof entries !== 'object' || entries === null) return undefined

  return { entries: entries as Record<string, unknown>, name: id.slice(separator + 1) }
}

/**
 * Resolve which prunable component entries are still reachable, following
 * `$ref`s transitively so an entry referenced only by another kept entry
 * survives.
 */
function resolveReachableComponents(
  document: OpenApiDocumentLike,
  components: Record<string, unknown>,
): Set<ComponentId> {
  const queue: string[] = []
  const roots = new Set<string>()
  collectRootRefs(document, roots)
  queue.push(...roots)

  const reachable = new Set<ComponentId>()
  while (queue.length > 0) {
    const id = parseComponentRef(queue.pop() as string)
    if (id === undefined || reachable.has(id)) continue

    const component = readComponent(components, id)
    if (component === undefined || !(component.name in component.entries)) continue
    reachable.add(id)

    const nestedRefs = new Set<string>()
    collectRefs(component.entries[component.name], nestedRefs)
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
 * Prefer this when the swagger instance is already wired to something else (a
 * static export step, a UI that cannot be pointed at a second document) and
 * registering the plugin a second time is awkward. Prefer two registrations
 * when the two documents should differ in more than their operation set
 * (title, servers, security).
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
  const markerKey = options?.markerKey ?? DEFAULT_INTERNAL_MARKER_KEY
  assertInternalMarkerKey(markerKey, 'stripInternalOperations: `markerKey`')

  // `app.swagger()` hands back a cached object that must stay intact for the
  // internal document, so every edit below happens on a copy.
  const result = structuredClone(document)

  removeInternalOperations(result, markerKey)

  if (options?.prune ?? true) {
    pruneComponents(result)
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

function pruneComponents(document: OpenApiDocumentLike): void {
  const components = document.components
  if (components === undefined) return

  const reachable = resolveReachableComponents(document, components)

  for (const section of Object.keys(components)) {
    if (!PRUNABLE_COMPONENT_SECTIONS.has(section)) continue

    const entries = components[section]
    if (typeof entries !== 'object' || entries === null) continue

    const entryRecord = entries as Record<string, unknown>
    for (const name of Object.keys(entryRecord)) {
      if (!reachable.has(`${section}/${name}`)) delete entryRecord[name]
    }

    if (Object.keys(entryRecord).length === 0) delete components[section]
  }
}

function pruneTags(document: OpenApiDocumentLike): void {
  if (!Array.isArray(document.tags)) return

  const usedTags = new Set<string>()
  collectTagNames(document.paths, usedTags)
  document.tags = document.tags.filter((tag) => tag.name === undefined || usedTags.has(tag.name))
}
