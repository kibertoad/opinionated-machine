// Renders the acceptance manifest to a YAML file that docker-compose mounts
// into the Kong container. Run before `docker compose up`.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderKongConfig } from '../dist/render.js'
import { acceptanceManifest } from './manifest.acceptance.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const outDir = join(__dirname, 'generated')
mkdirSync(outDir, { recursive: true })

const { yaml, warnings } = renderKongConfig(acceptanceManifest, {
  // The "upstream" name maps to the docker-compose service name.
  upstreams: { upstream: { url: 'http://upstream:8081' } },
})
writeFileSync(join(outDir, 'kong.yaml'), yaml)
if (warnings.length) {
  console.warn('[render-config] warnings:', warnings)
}
console.log('[render-config] wrote', join(outDir, 'kong.yaml'))
