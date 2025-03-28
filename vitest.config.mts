import { defineConfig } from 'vitest/config'

// biome-ignore lint/style/noDefaultExport: vite expects default export
export default defineConfig({
  test: {
    globals: true,
    watch: false,
    environment: 'node',
    reporters: ['verbose'],
    coverage: {
      provider: 'v8',
      include: ['lib/**/*.ts'],
      exclude: ['lib/**/*.spec.ts'],
      reporter: ['text', 'lcov'],
      all: true,
      thresholds: {
        statements: 91,
        branches: 88,
        functions: 91,
        lines: 91,
      },
    },
  },
})
