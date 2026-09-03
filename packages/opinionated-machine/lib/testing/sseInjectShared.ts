/**
 * Helpers shared by the contract-aware SSE inject helpers (legacy
 * `SSEContractDefinition` and `defineApiContract` flavours alike).
 *
 * @internal
 */

/** Truncate a long body string for error messages. */
const BODY_TRUNCATE_LIMIT = 500

export const truncateBody = (body: string): string => {
  if (body.length <= BODY_TRUNCATE_LIMIT) {
    return body
  }
  // Step back one unit if the cut would split a surrogate pair, so the
  // snippet never ends in a lone (invalid) surrogate.
  const lastCode = body.charCodeAt(BODY_TRUNCATE_LIMIT - 1)
  const end =
    lastCode >= 0xd800 && lastCode <= 0xdbff ? BODY_TRUNCATE_LIMIT - 1 : BODY_TRUNCATE_LIMIT
  return `${body.slice(0, end)}…`
}
