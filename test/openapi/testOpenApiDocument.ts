/**
 * Shared structural view of a generated document, plus the `internalSwagger`
 * decorator both OpenAPI e2e suites register.
 *
 * The module augmentation lives here rather than in each spec: declaring it
 * twice with two structurally identical local types is a TypeScript error.
 */
export type TestOpenApiOperation = {
  summary?: string
  'x-internal'?: boolean
}

export type TestOpenApiDocument = {
  info?: { title?: string }
  paths?: Record<string, Record<string, TestOpenApiOperation>>
  components?: { schemas?: Record<string, unknown> }
}

declare module 'fastify' {
  interface FastifyInstance {
    internalSwagger: () => TestOpenApiDocument
  }
}
