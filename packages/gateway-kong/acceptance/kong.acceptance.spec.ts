import { describe, expect, it } from 'vitest'

/**
 * Acceptance tests for the Kong generator. Driven by
 * `vitest.acceptance.config.ts` — run via `npm run test:acceptance`, which
 * boots `docker compose` with Kong (DB-less) + a Node stub upstream and runs
 * this file.
 *
 * The CI workflow `gateway-acceptance.yml` triggers it only when this package
 * or `lib/gateway` changes.
 */
const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://localhost:8000'

describe('kong acceptance', () => {
  it('routes GET /echo to the upstream', async () => {
    const res = await fetch(`${GATEWAY_URL}/echo`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { method: string; path: string }
    expect(body.method).toBe('GET')
    expect(body.path).toBe('/echo')
  })

  it('enforces the per-route request timeout', async () => {
    const res = await fetch(`${GATEWAY_URL}/slow?ms=2000`)
    // Kong returns 504 (Gateway Timeout) when read_timeout fires.
    expect(res.status).toBe(504)
  })

  it('rejects unknown paths with 404', async () => {
    const res = await fetch(`${GATEWAY_URL}/nope`)
    expect(res.status).toBe(404)
  })
})
