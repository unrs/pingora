import { defineConfig } from 'tsdown'

export default defineConfig({
  workspace: true,
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  target: 'node12',
  outDir: 'lib',
})
