import type { ApiContract } from '@lokalise/api-contracts'

/**
 * The `event name -> schema` map of an SSE body descriptor, or `never` for any other
 * descriptor (a bare Zod schema is JSON, `blobBody()` is opaque bytes).
 */
export type SseSchemasOfDescriptor<Descriptor> = Descriptor extends {
  _tag: 'SseBody'
  schemaByEventName: infer Schemas
}
  ? Schemas
  : never

/**
 * Every SSE schema map a response entry declares, across all of its media types — the
 * type-level counterpart of the maps `getSseSchemaByEventName` collects at runtime.
 */
type SseSchemasOfEntry<Entry> = Entry extends { content: infer Content }
  ? SseSchemasOfDescriptor<Content[keyof Content]>
  : never

/**
 * Union of the SSE schema maps a contract declares, over *every* status key.
 *
 * Deliberately not `InferSseSuccessResponses`, which only looks at success / `'2xx'` /
 * `'default'` keys: the runtime `getSseSchemaByEventName` merges the maps of every entry in
 * `responsesByStatusCode`, so a stream declared under e.g. `'4xx'` produces validated events
 * too and has to be visible here.
 */
export type ApiSSEEventSchemas<Contract extends ApiContract> = SseSchemasOfEntry<
  NonNullable<Contract['responsesByStatusCode'][keyof Contract['responsesByStatusCode']]>
>

/**
 * The event names of a union of schema maps.
 *
 * `keyof` a union yields only the keys shared by every member, which collapses to `never` as
 * soon as two statuses declare different events — so distribute first and union the keys,
 * mirroring the runtime merge.
 */
export type SseEventNamesOf<Schemas> = Schemas extends unknown ? keyof Schemas & string : never

/**
 * The schema(s) a union of maps declares for one event name. Maps that don't declare it drop
 * out; two maps declaring it with different schemas yield a union, since the runtime merge
 * keeps only one of them and the reader can't tell which.
 */
export type SseSchemaForEventName<Schemas, Name extends string> =
  Schemas extends Record<Name, infer Schema> ? Schema : never
