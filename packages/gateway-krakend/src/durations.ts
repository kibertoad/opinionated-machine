/**
 * Pass through a universal `Duration` string into a KrakenD duration.
 *
 * KrakenD accepts a wider Go-style set (`ns`, `us` / `µs`, `ms`, `s`, `m`,
 * `h`), but the *universal* `Duration` model declared in
 * `opinionated-machine/lib/gateway/gatewayMetadata.ts` only allows
 * `ms` / `s` / `m` / `h` and is enforced at attach time. So inputs that
 * reach this function are already constrained to that subset; the regex
 * here is a defensive belt-and-braces check, not a parser.
 */
export function toKrakendDuration(input: string): string {
  if (!/^\d+(ms|s|m|h)$/.test(input)) {
    throw new Error(`Unsupported duration "${input}" — expected formats like "5s", "300ms".`)
  }
  return input
}
