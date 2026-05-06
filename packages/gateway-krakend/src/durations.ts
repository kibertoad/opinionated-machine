/**
 * KrakenD durations are Go-style (`5s`, `300ms`, `1m`). Our universal format
 * already matches Go's grammar, so this is a pass-through with light validation.
 */
export function toKrakendDuration(input: string): string {
  if (!/^\d+(ms|s|m|h)$/.test(input)) {
    throw new Error(`Unsupported duration "${input}" — expected formats like "5s", "300ms".`)
  }
  return input
}
