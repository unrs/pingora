import assert from 'node:assert/strict'
import { onTestFinished, test } from 'vitest'

import { Server } from '../index.js'
import {
  createProxy,
  eventually,
  freePort,
  request,
  startUpstream,
  waitForProxy,
} from './helpers.mjs'

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

  const route = await eventually(() => {
    const route = proxy.server.routeMetrics('api')
    return route?.active === 0 && route.responsesOk === 1 ? route : null
  }, 'route metrics did not settle')
  assert.equal(route.requests, 1)

  const prometheus = proxy.server.metricsPrometheus()
  assert.match(prometheus, /pingora_requests_total 1/)
  assert.match(prometheus, /pingora_route_requests_total\{route="api"\} 1/)
  assert.match(prometheus, /pingora_responses_total\{class="2xx"\} 1/)
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

test('least-connections prefers the idle upstream', async () => {
  let markSlowStarted
  let releaseSlow
  const slowStarted = new Promise((resolve) => {
    markSlowStarted = resolve
  })
  const slowRelease = new Promise((resolve) => {
    releaseSlow = resolve
  })
  const slow = await startUpstream(async (req, res) => {
    if (req.url === '/lb/slow') {
      markSlowStarted()
      await slowRelease
    }
    res.end('slow')
  })
  const fast = await startUpstream((_req, res) => res.end('fast'))
  const ready = await startUpstream((_req, res) => res.end('ready'))
  onTestFinished(() => slow.close())
  onTestFinished(() => fast.close())
  onTestFinished(() => ready.close())

  const proxy = await createProxy({
    routes: [
      {
        path: '/ready',
        upstreams: [`127.0.0.1:${ready.port}`],
      },
      {
        pathPrefix: '/lb',
        strategy: 'least_connections',
        upstreams: [`127.0.0.1:${slow.port}`, `127.0.0.1:${fast.port}`],
      },
    ],
  })
  onTestFinished(() => proxy.stop())

  const readyResponse = await waitForProxy(`http://127.0.0.1:${proxy.port}/ready`)
  await readyResponse.text()

  const slowRequest = fetch(`http://127.0.0.1:${proxy.port}/lb/slow`)
  await slowStarted
  try {
    const fastResponse = await fetch(`http://127.0.0.1:${proxy.port}/lb/fast`)
    assert.equal(await fastResponse.text(), 'fast')
  } finally {
    releaseSlow()
  }
  assert.equal(await (await slowRequest).text(), 'slow')
})

test('weighted round-robin follows upstream weights', async () => {
  const first = await startUpstream((_req, res) => res.end('first'))
  const second = await startUpstream((_req, res) => res.end('second'))
  onTestFinished(() => first.close())
  onTestFinished(() => second.close())

  const proxy = await createProxy({
    routes: [
      {
        pathPrefix: '/',
        strategy: 'weighted_round_robin',
        upstreams: [
          { address: `127.0.0.1:${first.port}`, weight: 3 },
          { address: `127.0.0.1:${second.port}`, weight: 1 },
        ],
      },
    ],
  })
  onTestFinished(() => proxy.stop())

  await waitForProxy(`http://127.0.0.1:${proxy.port}/`)
  const bodies = []
  for (let index = 0; index < 8; index += 1) {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/weighted`)
    bodies.push(await response.text())
  }
  assert.equal(bodies.filter((body) => body === 'first').length, 6)
  assert.equal(bodies.filter((body) => body === 'second').length, 2)

  for (const weight of [0, -1, 1.5, 4294967296, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () =>
        proxy.server.addRoute({
          pathPrefix: '/bad-weight',
          upstreams: [{ address: `127.0.0.1:${first.port}`, weight }],
        }),
      /positive u32 integer/,
    )
  }
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

test('skips an upstream after a connection failure', async () => {
  const healthy = await startUpstream((_req, res) => res.end('healthy'))
  const dead = await freePort()
  onTestFinished(() => healthy.close())

  const proxy = await createProxy({
    routes: [
      {
        strategy: 'first',
        pathPrefix: '/',
        upstreams: [`127.0.0.1:${dead}`, `127.0.0.1:${healthy.port}`],
      },
    ],
  })
  onTestFinished(() => proxy.stop())

  const failed = await waitForProxy(`http://127.0.0.1:${proxy.port}/first`)
  assert.equal(failed.status, 502)
  await failed.text()

  const recovered = await eventually(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${proxy.port}/second`)
      return response.status === 200 ? response : null
    } catch {
      return null
    }
  }, 'healthy upstream was not selected after failure')
  assert.equal(await recovered.text(), 'healthy')
})

test('actively probes upstreams before routing', async () => {
  const healthy = await startUpstream((_req, res) => res.end('healthy'))
  const dead = await freePort()
  onTestFinished(() => healthy.close())

  const proxy = await createProxy({
    healthCheckIntervalMs: 50,
    routes: [
      {
        strategy: 'first',
        pathPrefix: '/',
        upstreams: [`127.0.0.1:${dead}`, `127.0.0.1:${healthy.port}`],
      },
    ],
  })
  onTestFinished(() => proxy.stop())

  await new Promise((resolve) => setTimeout(resolve, 300))
  const response = await waitForProxy(`http://127.0.0.1:${proxy.port}/`)
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'healthy')
})

test('clears an upstream cooldown after a successful probe', async () => {
  const recoveringPort = await freePort()
  const fallback = await startUpstream((_req, res) => res.end('fallback'))
  onTestFinished(() => fallback.close())

  const proxy = await createProxy({
    healthCheckIntervalMs: 50,
    routes: [
      {
        strategy: 'first',
        pathPrefix: '/',
        upstreams: [`127.0.0.1:${recoveringPort}`, `127.0.0.1:${fallback.port}`],
      },
    ],
  })
  onTestFinished(() => proxy.stop())

  await new Promise((resolve) => setTimeout(resolve, 200))
  const fallbackResponse = await waitForProxy(`http://127.0.0.1:${proxy.port}/first`)
  assert.equal(fallbackResponse.status, 200)
  assert.equal(await fallbackResponse.text(), 'fallback')

  const recovering = await startUpstream((_req, res) => res.end('recovered'), recoveringPort)
  onTestFinished(() => recovering.close())

  const deadline = Date.now() + 2_000
  let body = null
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${proxy.port}/recover`)
      const text = await response.text()
      if (response.status === 200 && text === 'recovered') {
        body = text
        break
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(body, 'recovered')
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
  assert.throws(
    () =>
      proxy.server.addRoute({
        upstreams: ['127.0.0.1:1'],
        requestHeaders: { 'bad name': 'x' },
      }),
    /invalid header name/,
  )
  assert.throws(
    () =>
      proxy.server.addRoute({
        upstreams: ['127.0.0.1:1'],
        responseHeaders: { 'x-test': 'bad\nvalue' },
      }),
    /invalid value/,
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

test('concurrent stop calls both wait for the server thread', async () => {
  const proxy = await createProxy()
  await waitForProxy(`http://127.0.0.1:${proxy.port}/`)

  const first = proxy.server.stop()
  const second = proxy.server.stop()
  await Promise.all([first, second])
  assert.equal(proxy.server.status().state, 'stopped')

  const next = new Server({ listeners: [`127.0.0.1:${await freePort()}`] })
  next.start()
  await next.stop()
})

test('rejects an invalid log format', () => {
  const server = new Server({ logFormat: 'xml' })
  assert.throws(() => server.start(), /logFormat/)
})
