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
 *
 * Keyed by `TValues` — the actual list of values passed to `defineEventMetadata` —
 * not by the full `TMetadata[TField]` union. That way, accessing a guard for
 * an omitted variant is a type error instead of an `undefined` at runtime.
 */
export type MetadataGuards<
  TMetadata,
  TField extends keyof TMetadata,
  TValues extends TMetadata[TField] & (string | number),
> = {
  [V in TValues]: MetadataGuard<TMetadata, ExtractMetadata<TMetadata, TField, V>>
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
  return <
    TField extends keyof TMetadata & string,
    const TValues extends ReadonlyArray<TMetadata[TField] & (string | number)>,
  >(
    field: TField,
    values: TValues,
  ): MetadataGuards<TMetadata, TField, TValues[number]> => {
    const guards = {} as Record<string | number, MetadataGuard<TMetadata, TMetadata>>

    for (const value of values) {
      // Index by the raw value so numeric and string discriminants stay distinct
      // (e.g. `1` and `'1'` produce separate keys). Still safe under JS coercion
      // because the `metadata[field] === value` check inside the guard uses ===.
      guards[value] = (metadata: TMetadata): metadata is TMetadata => metadata[field] === value
    }

    return guards as MetadataGuards<TMetadata, TField, TValues[number]>
  }
}
