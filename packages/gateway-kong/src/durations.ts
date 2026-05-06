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

/** Kong's `proxy-cache` plugin and rate-limiting expect seconds. */
export function toSeconds(input: string): number {
  return Math.round(toMilliseconds(input) / 1000)
}
