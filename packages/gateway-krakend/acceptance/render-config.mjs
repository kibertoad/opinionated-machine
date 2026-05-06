// Renders the acceptance manifest to a JSON file mounted into the KrakenD
// container. Run before `docker compose up`.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderKrakendConfig } from '../dist/render.js'
import { acceptanceManifest } from './manifest.acceptance.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const outDir = join(__dirname, 'generated')
mkdirSync(outDir, { recursive: true })

const { json, warnings } = renderKrakendConfig(acceptanceManifest, {
  port: 8080,
  // The "upstream" name maps to the docker-compose service name.
  upstreams: { upstream: 'http://upstream:8081' },
})
writeFileSync(join(outDir, 'krakend.json'), JSON.stringify(json, null, 2))
if (warnings.length) {
  console.warn('[render-config] warnings:', warnings)
}
console.log('[render-config] wrote', join(outDir, 'krakend.json'))
