import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['__test__/**/*.test.mjs'],
    benchmark: {
      include: ['bench/**/*.bench.mjs'],
    },
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
})
