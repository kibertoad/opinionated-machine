import { describe, expect, it } from 'vitest'

/**
 * Acceptance tests for the KrakenD generator. Driven by
 * `vitest.acceptance.config.ts` — only run via `npm run test:acceptance`,
 * which boots `docker compose` with KrakenD + a Node stub upstream and runs
 * this file.
 *
 * The CI workflow `gateway-acceptance.yml` triggers it only when this package
 * or `lib/gateway` changes.
 */
const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://localhost:8080'

describe('krakend acceptance', () => {
  it('routes GET /echo to the upstream', async () => {
    const res = await fetch(`${GATEWAY_URL}/echo`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { method: string; path: string }
    expect(body.method).toBe('GET')
    expect(body.path).toBe('/echo')
  })

  it('enforces the per-route request timeout', async () => {
    const res = await fetch(`${GATEWAY_URL}/slow?ms=2000`)
    // KrakenD returns 500 on backend timeout; some versions use 504.
    expect([500, 504]).toContain(res.status)
  })

  it('rejects unknown paths with 404', async () => {
    const res = await fetch(`${GATEWAY_URL}/nope`)
    expect(res.status).toBe(404)
  })
})
