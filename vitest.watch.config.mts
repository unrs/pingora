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
    include: ['__test__/**/*.test.mjs', '__test__/**/*.test.mts'],
    exclude: ['__test__/http-server-build.test.mts'],
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
})
