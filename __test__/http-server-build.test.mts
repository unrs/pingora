import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { test } from 'vitest'

const require = createRequire(import.meta.url)

const cjsPath = fileURLToPath(new URL('../packages/http-server/lib/index.cjs', import.meta.url))
const esmPath = fileURLToPath(new URL('../packages/http-server/lib/index.mjs', import.meta.url))

test.skipIf(!existsSync(cjsPath))('exposes a CommonJS entry', () => {
  const cjs = require(cjsPath)
  assert.equal(typeof cjs.createServer, 'function')
})

test.skipIf(!existsSync(esmPath))('exposes an ESM entry', async () => {
  const esm = await import(pathToFileURL(esmPath).href)
  assert.equal(typeof esm.createServer, 'function')
})
