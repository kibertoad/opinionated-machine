import { defineConfig } from 'vitest/config'

// biome-ignore lint/style/noDefaultExport: vite expects default export
export default defineConfig({
  test: {
    watch: false,
    environment: 'node',
    reporters: ['verbose'],
    exclude: ['**/node_modules/**', '**/dist/**', 'packages/**'],
    typecheck: {
      enabled: true,
      checker: 'tsc',
      include: ['lib/**/*.spec.ts', 'test/**/*.spec.ts'],
    },
    coverage: {
      provider: 'v8',
      include: ['lib/**/*.ts'],
      exclude: [
        'lib/AbstractController.ts', // Types and abstract class only
        'lib/sse/sseTypes.ts',
        'lib/testing/sseTestTypes.ts',
        'lib/**/index.ts', // Barrel exports
        'lib/**/*Types.ts', // Type definitions
        'lib/**/types.ts', // Type definitions
      ],
      reporter: ['text', 'lcov'],
      thresholds: {
        statements: 90,
        branches: 80,
        functions: 88,
        lines: 90,
      },
    },
  },
})
