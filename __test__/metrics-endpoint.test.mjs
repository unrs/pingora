import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  createProxy,
  eventually,
  freePort,
  startUpstream,
  waitForProxy,
} from './helpers.mjs'

test('serves metrics and health on a dedicated listener', async () => {
  const upstream = await startUpstream((_req, res) => res.end('ok'))
  const metricsPort = await freePort()
  const proxy = await createProxy({
    metricsAddress: `127.0.0.1:${metricsPort}`,
    routes: [{ id: 'app', pathPrefix: '/', upstreams: [`127.0.0.1:${upstream.port}`] }],
  })

  try {
    const response = await waitForProxy(`http://127.0.0.1:${proxy.port}/`)
    assert.equal(response.status, 200)

    const metrics = await eventually(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${metricsPort}/metrics`)
        return response.status === 200 ? response : null
      } catch {
        return null
      }
    }, 'metrics listener did not become ready')
    const body = await metrics.text()
    assert.match(body, /pingora_requests_total 1/)
    assert.match(body, /pingora_route_requests_total\{route="app"\} 1/)
    assert.equal(metrics.headers.get('content-type'), 'text/plain; version=0.0.4')

    const health = await fetch(`http://127.0.0.1:${metricsPort}/healthz`)
    assert.equal(health.status, 200)
    assert.equal(await health.text(), 'ok')

    const missing = await fetch(`http://127.0.0.1:${metricsPort}/missing`)
    assert.equal(missing.status, 404)

    assert.ok(proxy.server.status().listeners.includes(`127.0.0.1:${metricsPort}`))
  } finally {
    await proxy.stop()
    await upstream.close()
  }
})

test('rejects a hostname metrics address', async () => {
  const { Server } = await import('../index.js')
  const server = new Server({ metricsAddress: 'localhost:9090', logLevel: 'off' })
  assert.throws(() => server.start(), /IP:port/)
})

test('rejects a Unix metrics address', async () => {
  const { Server } = await import('../index.js')
  const server = new Server({ metricsAddress: 'unix:/tmp/metrics.sock', logLevel: 'off' })
  assert.throws(() => server.start(), /metrics address must be a TCP address/)
})

test('rejects a metrics address overlapping the proxy listener', async () => {
  const { Server } = await import('../index.js')
  const port = await freePort()
  const address = `127.0.0.1:${port}`
  const server = new Server({ listeners: [address], metricsAddress: address, logLevel: 'off' })
  assert.throws(() => server.start(), /overlaps a proxy listener/)
})

test('counts the metrics listener against maxListeners', async () => {
  const { Server } = await import('../index.js')
  const server = new Server({
    listeners: [`127.0.0.1:${await freePort()}`],
    metricsAddress: `127.0.0.1:${await freePort()}`,
    maxListeners: 1,
    logLevel: 'off',
  })
  assert.throws(() => server.start(), /maxListeners/)
})
