import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { onTestFinished, test } from 'vitest'

import { freePort } from './helpers.js'

const require = createRequire(import.meta.url)
const CHILD_TIMEOUT_MS = 12_000
const facadeCwd = fileURLToPath(new URL('..', import.meta.url))
const cjsPath = fileURLToPath(new URL('../packages/http-server/lib/index.cjs', import.meta.url))
const esmPath = fileURLToPath(new URL('../packages/http-server/lib/index.mjs', import.meta.url))

function spawnFacade(script: string) {
  const child = spawn(process.execPath, ['-e', script], {
    cwd: facadeCwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  onTestFinished(() => {
    child.kill()
  })
  return { child, stderr: () => stderr }
}

function waitForReady(child: ChildProcess, getStderr: () => string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child did not start: ${getStderr()}`)), CHILD_TIMEOUT_MS)
    child.stdout?.on('data', (chunk) => {
      if (chunk.toString().includes('ready')) {
        clearTimeout(timer)
        resolve()
      }
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`child exited early (${code}): ${getStderr()}`))
    })
  })
}

function waitForExit(child: ChildProcess, getStderr: () => string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child did not exit: ${getStderr()}`)), CHILD_TIMEOUT_MS)
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`child exited with ${code}: ${getStderr()}`))
    })
  })
}

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

test('keeps the process alive after start', async () => {
  const port = await freePort()
  const { child, stderr } = spawnFacade(`const { createServer } = require('@pingora/http-server')
const app = createServer({ listen: ${port}, handler: () => ({ body: 'alive' }) })
app.start().then(() => console.log('ready')).catch((error) => {
  console.error(error)
  process.exit(1)
})`)
  await waitForReady(child, stderr)

  const response = await fetch(`http://127.0.0.1:${port}/`)
  assert.equal(response.status, 200, stderr())
  assert.equal(await response.text(), 'alive')
  assert.equal(child.exitCode, null)
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
    child.kill()
  })
})

test('unref lets the process exit after start', async () => {
  const port = await freePort()
  const { child, stderr } = spawnFacade(`const { createServer } = require('@pingora/http-server')
const app = createServer({
  listen: ${port},
  unref: true,
  handler: () => ({ body: 'alive' }),
})
app.start().then(() => console.log('ready')).catch((error) => {
  console.error(error)
  process.exit(1)
})`)
  await waitForExit(child, stderr)
})

test('releases the keepalive after app.server.stop()', async () => {
  const port = await freePort()
  const { child, stderr } = spawnFacade(`const { createServer } = require('@pingora/http-server')
const app = createServer({ listen: ${port}, handler: () => ({ body: 'alive' }) })
app.start().then(() => app.server.stop()).catch((error) => {
  console.error(error)
  process.exit(1)
})`)
  await waitForExit(child, stderr)
})

test('resolves through the package exports map', () => {
  const cjs = spawnSync(
    process.execPath,
    ['-e', "const m = require('@pingora/http-server'); if (typeof m.createServer !== 'function') process.exit(1)"],
    { cwd: facadeCwd, encoding: 'utf8' },
  )
  assert.equal(cjs.status, 0, cjs.stderr)

  const esm = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "const m = await import('@pingora/http-server'); if (typeof m.createServer !== 'function') process.exit(1)",
    ],
    { cwd: facadeCwd, encoding: 'utf8' },
  )
  assert.equal(esm.status, 0, esm.stderr)
})

test('serves from the CommonJS artifact', async () => {
  assert.equal(existsSync(cjsPath), true, 'missing lib/index.cjs')
  await exercise(require(cjsPath).createServer)
})

test('serves from the ESM artifact', async () => {
  assert.equal(existsSync(esmPath), true, 'missing lib/index.mjs')
  await exercise((await import(pathToFileURL(esmPath).href)).createServer)
})
