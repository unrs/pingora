import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { onTestFinished, test } from 'vitest'

import { Server } from '../index.js'

async function freePort() {
  const probe = net.createServer()
  await new Promise((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  return port
}

async function startUpstream(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

async function waitForProxy(url) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await fetch(url)
    } catch {
      await delay(50)
    }
  }
  throw new Error(`proxy at ${url} did not become ready`)
}

async function eventually(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = predicate()
    if (value) return value
    await delay(10)
  }
  throw new Error(message)
}

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString(),
        }),
      )
    })
    req.once('error', reject)
    req.end()
  })
}

async function createProxy(options = {}) {
  const port = await freePort()
  const server = new Server({
    listeners: [`127.0.0.1:${port}`],
    gracePeriodMs: 0,
    shutdownTimeoutMs: 0,
    logLevel: 'off',
    ...options,
  })
  server.start()
  return { server, port, stop: () => server.stop() }
}

test('proxies requests, applies headers, and reports metrics', async () => {
  let seen
  const upstream = await startUpstream((req, res) => {
    res.setHeader('x-upstream', 'yes')
    seen = { route: req.headers['x-route'], url: req.url }
    res.end('ok')
  })
  onTestFinished(() => upstream.close())

  const proxy = await createProxy({
    routes: [
      {
        id: 'api',
        pathPrefix: '/api',
        methods: ['GET'],
        upstreams: [`127.0.0.1:${upstream.port}`],
        requestHeaders: { 'x-route': 'api' },
        responseHeaders: { 'x-proxied': 'yes' },
        removeResponseHeaders: ['x-upstream'],
      },
    ],
  })
  onTestFinished(() => proxy.stop())

  const response = await waitForProxy(`http://127.0.0.1:${proxy.port}/api/hello?q=1`)
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'ok')
  assert.deepEqual(seen, { route: 'api', url: '/api/hello?q=1' })
  assert.equal(response.headers.get('x-proxied'), 'yes')
  assert.equal(response.headers.get('x-upstream'), null)

  const metrics = await eventually(() => {
    const metrics = proxy.server.metrics()
    return metrics.active === 0 && metrics.responsesOk === 1 ? metrics : null
  }, 'metrics did not settle')
  assert.equal(metrics.requests, 1)
  assert.equal(metrics.upstreamErrors, 0)
})

test('returns 404 for unmatched routes', async () => {
  const proxy = await createProxy({
    routes: [{ path: '/known', upstreams: ['127.0.0.1:1'] }],
  })
  onTestFinished(() => proxy.stop())

  const response = await waitForProxy(`http://127.0.0.1:${proxy.port}/missing`)
  assert.equal(response.status, 404)
  assert.equal(await response.text(), 'no route matched')
  await eventually(
    () => proxy.server.metrics().responsesClientError === 1,
    '404 metric did not update',
  )
})

test('round-robins across upstreams', async () => {
  const first = await startUpstream((_req, res) => res.end('first'))
  const second = await startUpstream((_req, res) => res.end('second'))
  onTestFinished(() => first.close())
  onTestFinished(() => second.close())

  const proxy = await createProxy({
    routes: [
      {
        pathPrefix: '/',
        upstreams: [`127.0.0.1:${first.port}`, `127.0.0.1:${second.port}`],
        strategy: 'round_robin',
      },
    ],
  })
  onTestFinished(() => proxy.stop())

  await waitForProxy(`http://127.0.0.1:${proxy.port}/`)
  const bodies = []
  for (let index = 0; index < 4; index += 1) {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/rr`)
    bodies.push(await response.text())
  }
  assert.equal(bodies.filter((body) => body === 'first').length, 2)
  assert.equal(bodies.filter((body) => body === 'second').length, 2)
})

test('matches host, path, method, and headers', async () => {
  const upstream = await startUpstream((_req, res) => res.end('matched'))
  onTestFinished(() => upstream.close())

  const proxy = await createProxy({
    routes: [
      {
        host: 'example.com',
        path: '/exact',
        methods: ['POST'],
        matchHeaders: { 'x-match': 'yes' },
        upstreams: [`127.0.0.1:${upstream.port}`],
      },
    ],
  })
  onTestFinished(() => proxy.stop())

  await waitForProxy(`http://127.0.0.1:${proxy.port}/exact`, {
    method: 'POST',
    headers: { host: 'other.com', 'x-match': 'yes' },
  })

  const matched = await request(`http://127.0.0.1:${proxy.port}/exact`, {
    method: 'POST',
    headers: { host: 'example.com', 'x-match': 'yes' },
  })
  assert.equal(matched.status, 200)
  assert.equal(matched.body, 'matched')

  const wrongHost = await request(`http://127.0.0.1:${proxy.port}/exact`, {
    method: 'POST',
    headers: { host: 'other.com', 'x-match': 'yes' },
  })
  assert.equal(wrongHost.status, 404)

  const wrongMethod = await request(`http://127.0.0.1:${proxy.port}/exact`, {
    method: 'GET',
    headers: { host: 'example.com', 'x-match': 'yes' },
  })
  assert.equal(wrongMethod.status, 404)

  const missingHeader = await request(`http://127.0.0.1:${proxy.port}/exact`, {
    method: 'POST',
    headers: { host: 'example.com' },
  })
  assert.equal(missingHeader.status, 404)
})

test('supports hot route updates', async () => {
  const upstream = await startUpstream((_req, res) => res.end('hot'))
  onTestFinished(() => upstream.close())

  const proxy = await createProxy()
  onTestFinished(() => proxy.stop())

  await waitForProxy(`http://127.0.0.1:${proxy.port}/`)

  const added = proxy.server.addRoute({
    id: 'hot',
    pathPrefix: '/hot',
    upstreams: [`127.0.0.1:${upstream.port}`],
  })
  assert.equal(added, 'hot')
  assert.equal(proxy.server.status().routes, 1)
  assert.equal((await fetch(`http://127.0.0.1:${proxy.port}/hot`)).status, 200)

  proxy.server.addRoute({
    id: 'hot',
    pathPrefix: '/hot',
    upstreams: [`127.0.0.1:${upstream.port}`],
    responseHeaders: { 'x-replaced': 'yes' },
  })
  assert.equal(proxy.server.status().routes, 1)
  assert.equal((await fetch(`http://127.0.0.1:${proxy.port}/hot`)).headers.get('x-replaced'), 'yes')

  assert.equal(proxy.server.removeRoute('hot'), true)
  assert.equal(proxy.server.status().routes, 0)
  assert.equal((await fetch(`http://127.0.0.1:${proxy.port}/hot`)).status, 404)
  assert.equal(proxy.server.removeRoute('hot'), false)
})

test('returns 502 when the upstream is unavailable', async () => {
  const unavailablePort = await freePort()
  const proxy = await createProxy({
    routes: [{ pathPrefix: '/', upstreams: [`127.0.0.1:${unavailablePort}`] }],
  })
  onTestFinished(() => proxy.stop())

  const response = await waitForProxy(`http://127.0.0.1:${proxy.port}/down`)
  assert.equal(response.status, 502)
  const metrics = await eventually(() => {
    const metrics = proxy.server.metrics()
    return metrics.upstreamErrors === 1 && metrics.responsesServerError === 1
      ? metrics
      : null
  }, '502 metrics did not settle')
  assert.equal(metrics.active, 0)
})

test('rejects invalid routes and double start', async () => {
  const proxy = await createProxy()
  onTestFinished(() => proxy.stop())

  assert.throws(() => proxy.server.addRoute({ upstreams: [] }), /at least one upstream/)
  assert.throws(
    () => proxy.server.addRoute({ upstreams: ['localhost:3000'] }),
    /IP literal/,
  )
  assert.throws(() => proxy.server.start(), /already been started/)
})

test('stops idempotently and releases the port', async () => {
  const upstream = await startUpstream((_req, res) => res.end('bye'))
  onTestFinished(() => upstream.close())

  const proxy = await createProxy({
    routes: [{ pathPrefix: '/', upstreams: [`127.0.0.1:${upstream.port}`] }],
  })
  await waitForProxy(`http://127.0.0.1:${proxy.port}/`)

  await proxy.stop()
  assert.equal(proxy.server.status().state, 'stopped')
  await proxy.stop()
  assert.equal(proxy.server.status().state, 'stopped')
  await assert.rejects(fetch(`http://127.0.0.1:${proxy.port}/`))
})

test('rejects invalid listeners on start', async () => {
  const server = new Server({ listeners: ['not-an-address'] })
  assert.throws(() => server.start(), /listener|socket address/)
  assert.equal(server.status().state, 'failed')
})

test('enforces a single server per process', async () => {
  const proxy = await createProxy()
  onTestFinished(() => proxy.stop())

  const other = new Server({ listeners: [`127.0.0.1:${await freePort()}`] })
  assert.throws(() => other.start(), /another pingora server/)
  await other.stop()
})

test('stop before start is a no-op', async () => {
  const server = new Server({ listeners: [`127.0.0.1:${await freePort()}`] })
  await server.stop()
  assert.equal(server.status().state, 'idle')
})
