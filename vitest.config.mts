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
      exclude: [],
      reporter: ['text', 'lcov'],
      all: true,
      thresholds: {
        statements: 87,
        branches: 90,
        functions: 85,
        lines: 87,
      },
    },
  },
})
