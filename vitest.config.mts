import { defineConfig } from 'vitest/config'

// biome-ignore lint/style/noDefaultExport: vite expects default export
export default defineConfig({
  test: {
    watch: false,
    environment: 'node',
    reporters: ['verbose'],
    coverage: {
      provider: 'v8',
      include: ['lib/**/*.ts'],
      exclude: [
        'lib/AbstractController.ts', // Types and abstract class only
        'lib/sse/sseTypes.ts',
        'lib/testing/sseTestTypes.ts',
      ],
      reporter: ['text', 'lcov'],
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 80,
        lines: 90,
      },
    },
  },
})
