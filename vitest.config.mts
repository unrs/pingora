import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@pingora/http-server': fileURLToPath(
        new URL('./packages/http-server/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['test/**/*.spec.ts'],
    benchmark: {
      include: ['bench/**/*.bench.ts'],
    },
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
})
