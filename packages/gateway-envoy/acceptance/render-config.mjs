// Renders the acceptance manifest to a YAML file that docker-compose mounts
// into the Envoy container. Run before `docker compose up`.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderEnvoyConfig } from '../dist/render.js'
import { acceptanceManifest } from './manifest.acceptance.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const outDir = join(__dirname, 'generated')
mkdirSync(outDir, { recursive: true })

const { yaml, warnings } = renderEnvoyConfig(acceptanceManifest, {
  listenPort: 10000,
  // The "upstream" name maps to the docker-compose service name.
  clusters: { upstream: { hosts: ['upstream:8081'], connectTimeout: '1s' } },
})
writeFileSync(join(outDir, 'envoy.yaml'), yaml)
if (warnings.length) {
  console.warn('[render-config] warnings:', warnings)
}
console.log('[render-config] wrote', join(outDir, 'envoy.yaml'))
