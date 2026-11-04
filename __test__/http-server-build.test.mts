import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { test } from 'vitest'

const require = createRequire(import.meta.url)

const cjsPath = fileURLToPath(new URL('../packages/http-server/lib/index.cjs', import.meta.url))
const esmPath = fileURLToPath(new URL('../packages/http-server/lib/index.mjs', import.meta.url))

test('exposes a CommonJS entry', () => {
  assert.equal(existsSync(cjsPath), true, 'missing lib/index.cjs')
  const cjs = require(cjsPath)
  assert.equal(typeof cjs.createServer, 'function')
})

test('exposes an ESM entry', async () => {
  assert.equal(existsSync(esmPath), true, 'missing lib/index.mjs')
  const esm = await import(pathToFileURL(esmPath).href)
  assert.equal(typeof esm.createServer, 'function')
})
