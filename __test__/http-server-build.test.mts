import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { test } from 'vitest'

import { freePort } from './helpers.mjs'

const require = createRequire(import.meta.url)

const cjsPath = fileURLToPath(new URL('../packages/http-server/lib/index.cjs', import.meta.url))
const esmPath = fileURLToPath(new URL('../packages/http-server/lib/index.mjs', import.meta.url))

async function exercise(createServer: Function) {
  const port = await freePort()
  const app = createServer({
    listen: port,
    handler: () => ({ body: 'artifact' }),
  })
  await app.start()
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`)
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'artifact')
  } finally {
    await app.close()
  }
}

test('serves from the CommonJS artifact', async () => {
  assert.equal(existsSync(cjsPath), true, 'missing lib/index.cjs')
  await exercise(require(cjsPath).createServer)
})

test('serves from the ESM artifact', async () => {
  assert.equal(existsSync(esmPath), true, 'missing lib/index.mjs')
  await exercise((await import(pathToFileURL(esmPath).href)).createServer)
})
