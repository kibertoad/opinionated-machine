/**
 * Check if a value is an Error-like object (cross-realm safe).
 * Uses duck typing instead of instanceof for reliability across realms.
 */
export function isErrorLike(err: unknown): err is { message: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'message' in err &&
    typeof (err as { message: unknown }).message === 'string'
  )
}
