#!/usr/bin/env node
/**
 * Fails when a public workspace package's version is missing from the npm registry.
 *
 * `changeset publish` publishes packages one at a time. When one of them fails the
 * others are already live, and the run exits before any of them are tagged, so the
 * only record of which half landed is the registry itself. Reading it back turns a
 * partial release into a named list instead of a failure someone has to reconstruct
 * from the publish log.
 */
import { readdir, readFile } from 'node:fs/promises'

const PACKAGES_DIR = new URL('../packages/', import.meta.url)
const REGISTRY = 'https://registry.npmjs.org'

/** npm serves a publish to its own reads before it serves it to everyone else. */
const LOOKUP_ATTEMPTS = 5
const RETRY_DELAY_MS = 3_000

/** @returns {Promise<{ name: string, version: string }[]>} */
async function readPublicManifests() {
  const entries = await readdir(PACKAGES_DIR, { withFileTypes: true })
  const manifests = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const path = new URL(`${entry.name}/package.json`, PACKAGES_DIR)
        return JSON.parse(await readFile(path, 'utf8'))
      }),
  )

  return manifests
    .filter((manifest) => !manifest.private)
    .map(({ name, version }) => ({ name, version }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** @returns {Promise<boolean>} */
async function isPublished(name, version) {
  const response = await fetch(`${REGISTRY}/${encodeURIComponent(name)}`, { cache: 'no-store' })
  if (response.status === 404) return false
  if (!response.ok) {
    throw new Error(`Registry lookup for ${name} failed: ${response.status} ${response.statusText}`)
  }

  const { versions } = await response.json()
  return Boolean(versions?.[version])
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A lookup that never throws: a registry outage must not take the whole report with
 * it, or the one run that needs this script prints nothing at all.
 *
 * @returns {Promise<{ published: boolean, error?: string }>}
 */
async function lookup(name, version) {
  let error
  for (let attempt = 1; attempt <= LOOKUP_ATTEMPTS; attempt++) {
    try {
      if (await isPublished(name, version)) return { published: true }
      error = undefined
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    }
    if (attempt < LOOKUP_ATTEMPTS) await sleep(RETRY_DELAY_MS)
  }
  return { published: false, error }
}

const packages = await readPublicManifests()
const results = await Promise.all(
  packages.map(async (pkg) => ({ ...pkg, ...(await lookup(pkg.name, pkg.version)) })),
)

for (const { name, version, published, error } of results) {
  const state = published ? 'ok     ' : error ? 'ERROR  ' : 'MISSING'
  console.log(`${state}  ${name}@${version}${error ? ` (${error})` : ''}`)
}

const unresolved = results.filter((result) => !result.published)
if (unresolved.length === 0) {
  console.log(`\nAll ${results.length} public packages are on the registry.`)
  process.exit(0)
}

const list = unresolved.map(({ name, version }) => `${name}@${version}`).join(', ')
console.error(
  `\n::error::Not confirmed on the npm registry: ${list}. A first publish needs a trusted ` +
    'publisher configured on npmjs.com for that package; otherwise re-run this workflow to retry.',
)
process.exit(1)
