import assert from 'node:assert/strict'
import { test } from 'vitest'

import { createProxy, eventually, startUpstream, waitForProxy } from './helpers.mjs'

test('reports completed requests to an access log handler', async () => {
  const upstream = await startUpstream((_req, res) => res.end('ok'))
  const proxy = await createProxy({
    routes: [{ id: 'app', pathPrefix: '/', upstreams: [`127.0.0.1:${upstream.port}`] }],
  })
  const records = []
  try {
    proxy.server.setAccessLogHandler((error, record) => {
      records.push(record)
    })
    const response = await waitForProxy(`http://127.0.0.1:${proxy.port}/hello?x=1`)
    assert.equal(response.status, 200)

    const record = await eventually(() => records.at(-1), 'access log record did not arrive')
    assert.equal(record.method, 'GET')
    assert.equal(record.path, '/hello')
    assert.equal(record.status, 200)
    assert.equal(record.routeId, 'app')
    assert.equal(record.upstreamError, false)
    assert.ok(record.durationMs >= 0)

    proxy.server.clearAccessLogHandler()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const count = records.length
    const afterClear = await fetch(`http://127.0.0.1:${proxy.port}/after-clear`)
    await afterClear.text()
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(records.length, count)
  } finally {
    await proxy.stop()
    await upstream.close()
  }
})

test('marks upstream failures in the access log', async () => {
  const proxy = await createProxy({
    routes: [{ id: 'dead', pathPrefix: '/', upstreams: ['127.0.0.1:1'] }],
  })
  const records = []
  try {
    proxy.server.setAccessLogHandler((error, record) => {
      assert.equal(error, null)
      records.push(record)
    })
    const response = await waitForProxy(`http://127.0.0.1:${proxy.port}/`)
    assert.equal(response.status, 502)

    const record = await eventually(() => records.at(-1), 'failure access log did not arrive')
    assert.equal(record.status, 502)
    assert.equal(record.routeId, 'dead')
    assert.equal(record.upstreamError, true)
  } finally {
    await proxy.stop()
  }
})

test('does not crash when the access log handler throws', async () => {
  const upstream = await startUpstream((_req, res) => res.end('ok'))
  const proxy = await createProxy({
    routes: [{ pathPrefix: '/', upstreams: [`127.0.0.1:${upstream.port}`] }],
  })
  try {
    proxy.server.setAccessLogHandler((_error, _record) => {
      throw new Error('access log boom')
    })
    const response = await waitForProxy(`http://127.0.0.1:${proxy.port}/`)
    assert.equal(response.status, 200)
    await response.text()
  } finally {
    await proxy.stop()
    await upstream.close()
  }
})
