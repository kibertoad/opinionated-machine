/**
 * Type-level utility: extract a specific variant from a discriminated union.
 */
export type ExtractMetadata<
  TMetadata,
  TField extends keyof TMetadata,
  TValue extends TMetadata[TField],
> = Extract<TMetadata, Record<TField, TValue>>

/**
 * A type guard function for a specific variant of event metadata.
 */
export type MetadataGuard<TMetadata, TVariant extends TMetadata> = (
  metadata: TMetadata,
) => metadata is TVariant

/**
 * Map of discriminant values to their corresponding type guard functions.
 */
export type MetadataGuards<TMetadata, TField extends keyof TMetadata> = {
  [V in TMetadata[TField] & (string | number)]: MetadataGuard<
    TMetadata,
    ExtractMetadata<TMetadata, TField, V>
  >
}

/**
 * Create type-safe guard functions for a discriminated union metadata type.
 *
 * Returns an object mapping each discriminant value to a type guard function.
 * When a guard returns true, TypeScript narrows the metadata to the specific
 * variant, giving access to variant-specific fields.
 *
 * The double-invocation `defineEventMetadata<Type>()(field, values)` is needed
 * because TypeScript doesn't support partial type inference.
 *
 * @template TMetadata - The full discriminated union type
 *
 * @example
 * ```typescript
 * type EventMetadata =
 *   | { scope: 'project'; projectId: string }
 *   | { scope: 'team'; teamId: string }
 *   | { scope: 'global' }
 *
 * const metadata = defineEventMetadata<EventMetadata>()('scope', [
 *   'project',
 *   'team',
 *   'global',
 * ])
 *
 * if (metadata.project(event.metadata)) {
 *   // TypeScript narrows: event.metadata is { scope: 'project'; projectId: string }
 *   event.metadata.projectId // string
 * }
 * ```
 */
export function defineEventMetadata<TMetadata extends Record<string, unknown>>() {
  return <TField extends keyof TMetadata & string>(
    field: TField,
    values: ReadonlyArray<TMetadata[TField] & (string | number)>,
  ): MetadataGuards<TMetadata, TField> => {
    const guards = {} as MetadataGuards<TMetadata, TField>

    for (const value of values) {
      ;(guards as Record<string, unknown>)[String(value)] = (
        metadata: TMetadata,
      ): metadata is ExtractMetadata<TMetadata, TField, typeof value> => {
        return metadata[field] === value
      }
    }

    return guards
  }
}
