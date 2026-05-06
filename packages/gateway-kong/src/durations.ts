/**
 * Convert a universal duration string ("5s", "300ms", "1m", "2h") to milliseconds.
 *
 * Kong's timeout fields (`connect_timeout`, `read_timeout`, `write_timeout`)
 * are integers in milliseconds, so this is the canonical conversion.
 */
export function toMilliseconds(input: string): number {
  const match = /^(\d+)(ms|s|m|h)$/.exec(input)
  if (!match) {
    throw new Error(`Unsupported duration "${input}" — expected formats like "5s", "300ms".`)
  }
  const value = Number(match[1])
  const unit = match[2]
  switch (unit) {
    case 'ms':
      return value
    case 's':
      return value * 1000
    case 'm':
      return value * 60_000
    case 'h':
      return value * 3_600_000
    default:
      // Unreachable thanks to the regex.
      return value
  }
}

/**
 * Kong's `proxy-cache` plugin and rate-limiting take integer seconds — the
 * universal `Duration` model allows millisecond precision (e.g. `300ms`),
 * so we throw if the value isn't representable in whole seconds rather than
 * silently rounding (which can zero out small values or inflate large ones).
 */
export function toSeconds(input: string): number {
  const ms = toMilliseconds(input)
  if (ms % 1000 !== 0) {
    throw new Error(
      `Duration "${input}" cannot be represented in whole seconds, which Kong's plugin config requires.`,
    )
  }
  return ms / 1000
}
