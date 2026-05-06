/**
 * Convert a universal duration string ("5s", "300ms", "1m", "2h") to the
 * Envoy `Duration` format: `"<seconds>s"` or `"0.<fraction>s"`.
 *
 * Envoy accepts decimal seconds with `s` suffix in YAML/JSON config — this is
 * the simplest portable representation that works for both `route.timeout` and
 * `retry_policy.per_try_timeout` etc.
 */
export function toEnvoyDuration(input: string): string {
  const match = /^(\d+)(ms|s|m|h)$/.exec(input)
  if (!match) {
    throw new Error(`Unsupported duration "${input}" — expected formats like "5s", "300ms".`)
  }
  const value = Number(match[1])
  const unit = match[2]
  const seconds =
    unit === 'ms' ? value / 1000 : unit === 's' ? value : unit === 'm' ? value * 60 : value * 3600
  // Envoy accepts decimal seconds; trim trailing zeros to keep snapshots tidy.
  const formatted = Number.isInteger(seconds) ? String(seconds) : seconds.toString()
  return `${formatted}s`
}
