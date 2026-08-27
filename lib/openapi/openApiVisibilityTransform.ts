import { assertInternalMarkerKey, DEFAULT_INTERNAL_MARKER_KEY } from './internalMarker.ts'
import type { OpenApiRouteSchema, RouteVisibility } from './visibility.ts'
import { VISIBILITY_SCHEMA_KEY } from './visibility.ts'

/** Which audience a generated OpenAPI document is meant for. */
export type OpenApiAudience = 'public' | 'internal'

/**
 * Structural stand-in for `@fastify/swagger`'s `SwaggerTransform`.
 *
 * Declared locally so this package keeps `@fastify/swagger` out of its
 * dependency graph — the returned function is assignable to the plugin's
 * `transform` option, and any `SwaggerTransform`-shaped function (including
 * `fastify-type-provider-zod`'s `jsonSchemaTransform`) can be chained into it.
 */
export type OpenApiTransformInput = {
  schema: OpenApiRouteSchema
  url: string
  // biome-ignore lint/suspicious/noExplicitAny: route generics are erased at the document boundary
  route: any
  openapiObject?: unknown
  swaggerObject?: unknown
}

export type OpenApiTransformResult = { schema: OpenApiRouteSchema; url: string }

export type OpenApiTransform = (input: OpenApiTransformInput) => OpenApiTransformResult

/**
 * A transform to run underneath the visibility decision — typically
 * `jsonSchemaTransform` from `fastify-type-provider-zod`.
 */
// biome-ignore lint/suspicious/noExplicitAny: must accept both SwaggerTransform and jsonSchemaTransform verbatim
export type ChainedOpenApiTransform = (input: any) => { schema: any; url: string }

export type OpenApiVisibilityTransformOptions = {
  /**
   * `'public'` produces the customer-facing document: every route whose
   * contract is not public is hidden. `'internal'` produces the internal
   * document: those same routes are un-hidden and marked with
   * `x-internal: true`.
   */
  audience: OpenApiAudience

  /**
   * Visibility values treated as public. Everything else counts as internal.
   *
   * Widening this un-hides the matching routes in the public document even
   * though the route builders hid them: the builders fail closed on anything
   * that is not literally `'public'`, and this option is how a service opts a
   * further audience (say `'partner'`) back into its customer-facing spec.
   *
   * @default ['public']
   */
  publicVisibilities?: readonly RouteVisibility[]

  /**
   * When a route carries no `visibility` marker but is already hidden
   * (`schema.hide === true`), treat it as internal and surface it in the
   * internal document.
   *
   * This covers routes built directly by `@lokalise/fastify-api-contracts`
   * (`buildFastifyRoute`, `buildFastifyNoPayloadRoute`, …), which derive
   * `hide` from contract visibility but do not stamp the visibility itself.
   *
   * Set to `false` if `hide: true` in your service means "never document
   * this, anywhere". The `X-HIDDEN` tag (`@fastify/swagger`'s `hiddenTag`)
   * is the audience-independent escape hatch either way: this transform
   * never touches tags, so an `X-HIDDEN` route stays out of both documents.
   *
   * @default true
   */
  treatHiddenAsInternal?: boolean

  /**
   * Routes to keep out of every document, whatever the audience.
   *
   * `hide: true` is also how documentation UIs and other plumbing keep their
   * own routes out of the spec — `@fastify/swagger-ui` and
   * `@scalar/fastify-api-reference` both set it on every asset route they
   * register. `treatHiddenAsInternal` cannot tell that apart from a
   * contract-derived hide, so without an exclusion those routes surface in the
   * internal document. Match them here, usually by `url` prefix.
   *
   * Excluded routes are hidden and never marked internal, so nothing derives
   * them back into the public document either.
   *
   * @example
   * ```ts
   * exclude: ({ url }) => url.startsWith('/documentation') || url.startsWith('/reference')
   * ```
   */
  exclude?: (input: OpenApiTransformInput) => boolean

  /**
   * Key marking internal operations in the internal document, so readers (and
   * {@link stripInternalOperations}) can tell them apart from public ones.
   *
   * Must start with `x-`, and is rejected otherwise: `@fastify/swagger` copies
   * only `x-`-prefixed schema keys into the generated operation and silently
   * drops the rest, which would leave `stripInternalOperations` nothing to
   * match on and publish every internal operation as the public spec.
   *
   * Marking is not optional. It is the only record of the audience decision
   * that survives into the document, and the entire contract the derived
   * public document rests on.
   *
   * @default 'x-internal'
   */
  internalMarkerKey?: string

  /**
   * Transform to run underneath this one, on the audience-adjusted schema.
   *
   * Order matters: `jsonSchemaTransform` short-circuits on `hide: true` and
   * throws away the Zod schemas, so the visibility decision has to happen
   * first. Chaining here guarantees that.
   */
  transform?: ChainedOpenApiTransform
}

const DEFAULT_PUBLIC_VISIBILITIES: readonly RouteVisibility[] = ['public']

type AudienceDecision = {
  isInternal: boolean
  schema: OpenApiRouteSchema | undefined
}

/**
 * Decide whether a route is internal and produce the audience's copy of its
 * schema. Never mutates the input: the route schema is shared by every
 * document generated from the app, and by Fastify's own validation pipeline.
 */
function resolveAudienceSchema(
  originalSchema: OpenApiRouteSchema | undefined,
  audience: OpenApiAudience,
  publicVisibilities: readonly RouteVisibility[],
  treatHiddenAsInternal: boolean,
): AudienceDecision {
  const visibility = originalSchema?.[VISIBILITY_SCHEMA_KEY]
  const hasMarker = visibility !== undefined
  const isInternal = hasMarker
    ? !publicVisibilities.includes(visibility)
    : treatHiddenAsInternal && originalSchema?.hide === true

  if (originalSchema === undefined) return { isInternal, schema: undefined }

  const schema: OpenApiRouteSchema = { ...originalSchema }
  delete schema[VISIBILITY_SCHEMA_KEY]

  if (hasMarker) {
    // A stamped route's `hide` flag is derived from its visibility, so the
    // audience owns it outright — including un-hiding a route the builder hid
    // under a stricter `publicVisibilities` default.
    schema.hide = isInternal && audience === 'public'
  } else if (isInternal) {
    // No marker: only ever relax `hide`, never tighten or invent it.
    schema.hide = audience === 'public'
  }

  return { isInternal, schema }
}

/**
 * The audience-independent opt-out: hidden everywhere, marked nowhere.
 *
 * Equivalent to `@fastify/swagger`'s `X-HIDDEN` tag, but usable against routes
 * whose schema the service does not own — which is the case for every route a
 * documentation UI registers on its own behalf.
 */
function excludedSchema(originalSchema: OpenApiRouteSchema | undefined): AudienceDecision {
  // A schema-less route is documented by default, so exclusion has to supply
  // the `hide` it would otherwise have nothing to set.
  const schema: OpenApiRouteSchema = { ...originalSchema, hide: true }
  delete schema[VISIBILITY_SCHEMA_KEY]

  return { isInternal: false, schema }
}

/**
 * Build a `@fastify/swagger` `transform` that re-derives the `hide` flag from
 * contract visibility for a given audience.
 *
 * The route builders fail closed: an `internal` contract is registered with
 * `schema.hide: true`, so a service that does nothing keeps internal endpoints
 * out of its OpenAPI document. That is the right default for a customer-facing
 * spec and the wrong one for the teams consuming the service internally —
 * this transform lets both documents be generated from the same routes.
 *
 * Register `@fastify/swagger` twice, with different `decorator` names, and give
 * each registration its own audience:
 *
 * @example
 * ```ts
 * import fastifySwagger from '@fastify/swagger'
 * import { jsonSchemaTransform } from 'fastify-type-provider-zod'
 * import { openApiVisibilityTransform } from 'opinionated-machine'
 *
 * // customer-facing document -> app.swagger()
 * await app.register(fastifySwagger, {
 *   openapi: { info: { title: 'Users API', version: '1.0.0' } },
 *   transform: openApiVisibilityTransform({
 *     audience: 'public',
 *     transform: jsonSchemaTransform,
 *   }),
 * })
 *
 * // internal document -> app.internalSwagger()
 * await app.register(fastifySwagger, {
 *   decorator: 'internalSwagger',
 *   openapi: { info: { title: 'Users API (internal)', version: '1.0.0' } },
 *   transform: openApiVisibilityTransform({
 *     audience: 'internal',
 *     transform: jsonSchemaTransform,
 *   }),
 * })
 * ```
 *
 * The returned function never mutates the route's schema — the same route
 * objects feed every registered document, so each transform works on a copy.
 */
export function openApiVisibilityTransform(
  options: OpenApiVisibilityTransformOptions,
): OpenApiTransform {
  const {
    audience,
    publicVisibilities = DEFAULT_PUBLIC_VISIBILITIES,
    treatHiddenAsInternal = true,
    exclude,
    internalMarkerKey = DEFAULT_INTERNAL_MARKER_KEY,
    transform: innerTransform,
  } = options

  // Fail here rather than at document-generation time: a marker key the
  // plugin drops produces a perfectly valid-looking internal document whose
  // derived public version leaks every internal operation.
  assertInternalMarkerKey(internalMarkerKey, 'openApiVisibilityTransform: `internalMarkerKey`')

  return (input: OpenApiTransformInput): OpenApiTransformResult => {
    const { isInternal, schema } = exclude?.(input)
      ? excludedSchema(input.schema as OpenApiRouteSchema | undefined)
      : resolveAudienceSchema(
          input.schema as OpenApiRouteSchema | undefined,
          audience,
          publicVisibilities,
          treatHiddenAsInternal,
        )

    const result: OpenApiTransformResult = innerTransform
      ? innerTransform({ ...input, schema })
      : { schema: schema as OpenApiRouteSchema, url: input.url }

    if (isInternal && audience === 'internal' && result.schema) {
      result.schema = { ...result.schema, [internalMarkerKey]: true }
    }

    return result
  }
}
