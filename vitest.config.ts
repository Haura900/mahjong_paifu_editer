import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.stress.test.ts'],
    coverage: {
      reporter: ['text', 'html'],
    },
  },
})
