import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { Server } from '../index.js'
import { createProxy, startUpstream, waitForProxy } from './helpers.mjs'

async function tempSocket() {
  const directory = await mkdtemp(join(tmpdir(), 'pingora-uds-'))
  return { directory, socketPath: join(directory, 'proxy.sock') }
}

function requestUds(socketPath, path = '/') {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () =>
        resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }),
      )
    })
    request.once('error', reject)
    request.end()
  })
}

test('listens on a Unix domain socket', async () => {
  const upstream = await startUpstream((_req, res) => res.end('upstream'))
  const { directory, socketPath } = await tempSocket()
  const server = new Server({
    listeners: [`unix:${socketPath}`],
    routes: [{ pathPrefix: '/', upstreams: [`127.0.0.1:${upstream.port}`] }],
    gracePeriodMs: 0,
    shutdownTimeoutMs: 0,
    logLevel: 'off',
  })

  try {
    server.start()
    let response
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        response = await requestUds(socketPath)
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
    assert.ok(response)
    assert.equal(response.status, 200)
    assert.equal(response.body, 'upstream')
  } finally {
    await server.stop()
    await upstream.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('proxies to a Unix domain socket upstream', async () => {
  const { directory, socketPath } = await tempSocket()
  const upstream = http.createServer((_req, res) => res.end('unix-upstream'))
  await new Promise((resolve, reject) => {
    upstream.once('error', reject)
    upstream.listen(socketPath, resolve)
  })

  const proxy = await createProxy({
    routes: [{ pathPrefix: '/', upstreams: [`unix:${socketPath}`] }],
  })
  try {
    await waitForProxy(`http://127.0.0.1:${proxy.port}/`)
    const response = await fetch(`http://127.0.0.1:${proxy.port}/`)
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'unix-upstream')
  } finally {
    await proxy.stop()
    await new Promise((resolve) => upstream.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects TLS on a Unix listener', async () => {
  const { directory, socketPath } = await tempSocket()
  try {
    const server = new Server({
      listeners: [
        {
          address: `unix:${socketPath}`,
          tls: { cert: '/missing/cert.pem', key: '/missing/key.pem' },
        },
      ],
      logLevel: 'off',
    })
    assert.throws(() => server.start(), /does not support TLS/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
