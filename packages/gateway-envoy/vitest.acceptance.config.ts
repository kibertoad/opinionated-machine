import { defineConfig } from 'vitest/config'

/**
 * Acceptance suite — runs only via `npm run test:acceptance`, which boots
 * docker compose with a real Envoy and stub upstream. Kept in a separate
 * config so the default `vitest run` (used by `npm test`) never picks them up.
 */
// biome-ignore lint/style/noDefaultExport: vite expects default export
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['acceptance/**/*.acceptance.spec.ts'],
    // Acceptance traffic includes 2s timeout assertions and container startup; allow generous time.
    testTimeout: 30000,
  },
})
