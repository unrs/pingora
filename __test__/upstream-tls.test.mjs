import assert from 'node:assert/strict'
import https from 'node:https'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { onTestFinished, test } from 'vitest'

import { createProxy, waitForProxy } from './helpers.mjs'

const certPath = fileURLToPath(new URL('./fixtures/cert.pem', import.meta.url))
const keyPath = fileURLToPath(new URL('./fixtures/key.pem', import.meta.url))
const caPath = fileURLToPath(new URL('./fixtures/ca.pem', import.meta.url))
const cert = readFileSync(certPath)
const key = readFileSync(keyPath)

async function startTlsUpstream() {
  const server = https.createServer({ cert, key }, (_req, res) => res.end('secure'))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

async function withTlsProxy(upstreams, run) {
  const upstream = await startTlsUpstream()
  const proxy = await createProxy({
    routes: [{ pathPrefix: '/', upstreams: upstreams(upstream.port) }],
  })
  try {
    await waitForProxy(`http://127.0.0.1:${proxy.port}/`)
    await run(proxy)
  } finally {
    await proxy.stop()
    await upstream.close()
  }
}

test('verifies an upstream with a custom CA and SNI', async () => {
  await withTlsProxy(
    (port) => [
      {
        address: `https://127.0.0.1:${port}`,
        sni: 'localhost',
        ca: caPath,
      },
    ],
    async (proxy) => {
      const response = await fetch(`http://127.0.0.1:${proxy.port}/`)
      assert.equal(response.status, 200)
      assert.equal(await response.text(), 'secure')
    },
  )
})

test('supports an explicit upstream TLS verification opt-out', async () => {
  await withTlsProxy(
    (port) => [{ address: `https://127.0.0.1:${port}`, verify: false }],
    async (proxy) => {
      const response = await fetch(`http://127.0.0.1:${proxy.port}/`)
      assert.equal(response.status, 200)
      assert.equal(await response.text(), 'secure')
    },
  )
})

test('rejects an untrusted upstream certificate by default', async () => {
  await withTlsProxy(
    (port) => [`https://127.0.0.1:${port}`],
    async (proxy) => {
      const response = await fetch(`http://127.0.0.1:${proxy.port}/`)
      assert.equal(response.status, 502)
    },
  )
})

test('rejects ca without TLS and invalid CA files', async () => {
  const proxy = await createProxy()
  onTestFinished(() => proxy.stop())

  assert.throws(
    () =>
      proxy.server.addRoute({
        pathPrefix: '/',
        upstreams: [{ address: '127.0.0.1:443', ca: caPath }],
      }),
    /ca without TLS/,
  )

  assert.throws(
    () =>
      proxy.server.addRoute({
        pathPrefix: '/',
        upstreams: [
          {
            address: 'https://127.0.0.1:443',
            ca: '/missing/ca.pem',
          },
        ],
      }),
    /failed to load CA/,
  )
})
