import { describe, expect, it } from 'vitest'

/**
 * Acceptance tests for the Envoy generator. Driven by the
 * `vitest.acceptance.config.ts` config — they only run via
 * `npm run test:acceptance`, which:
 *
 *   1. builds the package (so `dist/` is up-to-date),
 *   2. renders the acceptance manifest to YAML,
 *   3. boots `docker compose` (Envoy + a Node stub upstream),
 *   4. runs this file under the acceptance vitest config,
 *   5. tears compose down.
 *
 * The CI workflow `gateway-acceptance.yml` runs the script only when this
 * package or `lib/gateway` changes.
 */
const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://localhost:10000'
const FETCH_TIMEOUT_MS = 10_000

const fetchGateway = (path: string, init?: RequestInit) =>
  fetch(`${GATEWAY_URL}${path}`, {
    ...init,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })

describe('envoy acceptance', () => {
  it('routes GET /echo to the upstream', async () => {
    const res = await fetchGateway('/echo')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { method: string; path: string }
    expect(body.method).toBe('GET')
    expect(body.path).toBe('/echo')
  })

  it('forwards arbitrary headers to the upstream', async () => {
    const res = await fetchGateway('/echo', { headers: { 'x-trace-id': 'abc123' } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { headers: Record<string, string | null> }
    expect(body.headers['x-trace-id']).toBe('abc123')
  })

  it('enforces the per-route request timeout', async () => {
    // /slow has a 200ms timeout in the manifest; ms=2000 exceeds it.
    const res = await fetchGateway('/slow?ms=2000')
    // Envoy returns 504 (Gateway Timeout) when the upstream exceeds route.timeout.
    expect(res.status).toBe(504)
  })

  it('rejects unknown paths with 404 from the gateway', async () => {
    const res = await fetchGateway('/nope')
    expect(res.status).toBe(404)
  })
})
