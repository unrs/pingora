import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import http from 'node:http'
import net from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { onTestFinished, test } from 'vitest'

import {
  createProxy,
  eventually,
  freePort,
  startUpstream,
  waitForProxy,
} from './helpers.mjs'

test('passes a request view and returns a synthetic response', async () => {
  const upstream = await startUpstream((_req, res) => res.end('upstream'))
  onTestFinished(() => upstream.close())

  const proxy = await createProxy({
    routes: [{ id: 'app', pathPrefix: '/', upstreams: [`127.0.0.1:${upstream.port}`] }],
  })
  onTestFinished(() => proxy.stop())

  const seen = []
  proxy.server.setRequestHandler(async (request) => {
    await delay(10)
    seen.push(request)
    if (request.path === '/health') {
      return {
        action: 'respond',
        status: 200,
        headers: { 'x-handler': 'yes' },
        body: 'healthy',
      }
    }
    return { action: 'continue' }
  })

  const response = await waitForProxy(`http://127.0.0.1:${proxy.port}/health?probe=1`)
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'healthy')
  assert.equal(response.headers.get('x-handler'), 'yes')

  assert.equal(seen.length, 1)
  assert.equal(seen[0].method, 'GET')
  assert.equal(seen[0].path, '/health')
  assert.equal(seen[0].query, 'probe=1')
  assert.equal(seen[0].routeId, 'app')
  assert.equal(seen[0].clientIp, '127.0.0.1')
  assert.equal(seen[0].scheme, 'http')
  assert.equal(seen[0].httpVersion, 'HTTP/1.1')
  assert.equal(seen[0].host, `127.0.0.1:${proxy.port}`)
  assert.equal(seen[0].headers.host, `127.0.0.1:${proxy.port}`)

  const head = await fetch(`http://127.0.0.1:${proxy.port}/health`, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(await head.text(), '')
  assert.equal(head.headers.get('content-length'), '7')

  const proxied = await waitForProxy(`http://127.0.0.1:${proxy.port}/other`)
  assert.equal(await proxied.text(), 'upstream')

  const metrics = await eventually(() => {
    const metrics = proxy.server.metrics()
    return metrics.active === 0 && metrics.responsesOk === 3 ? metrics : null
  }, 'synthetic response metrics did not settle')
  assert.equal(metrics.requests, 3)
  assert.equal(metrics.responsesOk, 3)
  assert.equal(metrics.active, 0)
})

test('overrides the upstream and mutates headers', async () => {
  let observed
  const first = await startUpstream((_req, res) => res.end('first'))
  const second = await startUpstream((req, res) => {
    observed = req.headers
    res.setHeader('x-remove-response', 'remove-me')
    res.end('second')
  })
  onTestFinished(() => first.close())
  onTestFinished(() => second.close())

  const proxy = await createProxy({
    routes: [
      {
        pathPrefix: '/',
        upstreams: [`127.0.0.1:${first.port}`],
        requestHeaders: { 'x-route-header': 'route', 'x-precedence': 'route' },
        responseHeaders: { 'x-route-response': 'route', 'x-response-precedence': 'route' },
      },
    ],
  })
  onTestFinished(() => proxy.stop())
  await waitForProxy(`http://127.0.0.1:${proxy.port}/`)

  proxy.server.setRequestHandler(async (request) => {
    if (request.path === '/second') {
      return {
        action: 'upstream',
        upstream: `127.0.0.1:${second.port}`,
        requestHeaders: { 'x-handler': 'yes', 'x-precedence': 'handler' },
        removeRequestHeaders: ['x-remove', 'x-route-header'],
        responseHeaders: { 'x-response': 'yes', 'x-response-precedence': 'handler' },
        removeResponseHeaders: ['x-remove-response', 'x-route-response'],
      }
    }
    return { action: 'continue' }
  })

  const response = await fetch(`http://127.0.0.1:${proxy.port}/second`, {
    headers: { 'x-remove': 'remove-me' },
  })
  assert.equal(await response.text(), 'second')
  assert.equal(response.headers.get('x-response'), 'yes')
  assert.equal(response.headers.get('x-remove-response'), null)
  assert.equal(response.headers.get('x-route-response'), null)
  assert.equal(response.headers.get('x-response-precedence'), 'handler')
  assert.equal(observed['x-handler'], 'yes')
  assert.equal(observed['x-remove'], undefined)
  assert.equal(observed['x-route-header'], undefined)
  assert.equal(observed['x-precedence'], 'handler')
})

test('maps handler errors, invalid decisions, and timeouts to 500', async () => {
  const upstream = await startUpstream((_req, res) => res.end('upstream'))
  onTestFinished(() => upstream.close())

  const proxy = await createProxy({
    handlerTimeoutMs: 50,
    routes: [{ pathPrefix: '/', upstreams: [`127.0.0.1:${upstream.port}`] }],
  })
  onTestFinished(() => proxy.stop())
  await waitForProxy(`http://127.0.0.1:${proxy.port}/`)

  proxy.server.setRequestHandler(async () => {
    throw new Error('boom')
  })
  assert.equal((await fetch(`http://127.0.0.1:${proxy.port}/throw`)).status, 500)

  proxy.server.setRequestHandler(async () => ({ action: 'invalid' }))
  assert.equal((await fetch(`http://127.0.0.1:${proxy.port}/invalid`)).status, 500)

  proxy.server.setRequestHandler(async () => ({ action: 'upstream' }))
  assert.equal((await fetch(`http://127.0.0.1:${proxy.port}/no-upstream`)).status, 500)

  proxy.server.setRequestHandler(async () => undefined)
  assert.equal((await fetch(`http://127.0.0.1:${proxy.port}/undefined`)).status, 500)


  proxy.server.setRequestHandler(async () => ({
    action: 'respond',
    headers: { 'bad header': 'value' },
  }))
  assert.equal((await fetch(`http://127.0.0.1:${proxy.port}/bad-header`)).status, 500)

  proxy.server.setRequestHandler(async () => {
    await delay(500)
    return { action: 'continue' }
  })
  assert.equal((await fetch(`http://127.0.0.1:${proxy.port}/slow`)).status, 500)
})

test('replaces and clears handlers while running', async () => {
  const upstream = await startUpstream((_req, res) => res.end('upstream'))
  onTestFinished(() => upstream.close())

  const proxy = await createProxy({
    routes: [{ pathPrefix: '/', upstreams: [`127.0.0.1:${upstream.port}`] }],
  })
  onTestFinished(() => proxy.stop())
  await waitForProxy(`http://127.0.0.1:${proxy.port}/`)

  proxy.server.setRequestHandler(async () => ({ action: 'respond', status: 201, body: 'a' }))
  assert.equal((await fetch(`http://127.0.0.1:${proxy.port}/`)).status, 201)

  proxy.server.setRequestHandler(async () => ({ action: 'respond', status: 202, body: 'b' }))
  assert.equal((await fetch(`http://127.0.0.1:${proxy.port}/`)).status, 202)

  proxy.server.setRequestHandler(async () => ({
    action: 'respond',
    status: 204,
    body: 'ignored',
  }))
  const noContent = await fetch(`http://127.0.0.1:${proxy.port}/`)
  assert.equal(noContent.status, 204)
  assert.equal(await noContent.text(), '')

  proxy.server.setRequestHandler(async () => ({ action: 'respond', status: 304 }))
  const notModified = await fetch(`http://127.0.0.1:${proxy.port}/`)
  assert.equal(notModified.status, 304)
  assert.equal(await notModified.text(), '')

  proxy.server.setRequestHandler((_request) => ({
    action: 'respond',
    status: 200,
    body: 'sync',
  }))
  const sync = await fetch(`http://127.0.0.1:${proxy.port}/`)
  assert.equal(sync.status, 200)
  assert.equal(await sync.text(), 'sync')

  proxy.server.clearRequestHandler()
  const response = await fetch(`http://127.0.0.1:${proxy.port}/`)
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'upstream')
})

test('keeps an in-flight handler alive after clearing it', async () => {
  const upstream = await startUpstream((_req, res) => res.end('upstream'))
  onTestFinished(() => upstream.close())

  const proxy = await createProxy({
    routes: [{ pathPrefix: '/', upstreams: [`127.0.0.1:${upstream.port}`] }],
  })
  onTestFinished(() => proxy.stop())
  await waitForProxy(`http://127.0.0.1:${proxy.port}/`)

  let entered
  let release
  const enteredPromise = new Promise((resolve) => {
    entered = resolve
  })
  const gate = new Promise((resolve) => {
    release = resolve
  })

  proxy.server.setRequestHandler(async () => {
    entered()
    await gate
    return { action: 'respond', status: 203, body: 'late' }
  })

  const pending = fetch(`http://127.0.0.1:${proxy.port}/slow`)
  await enteredPromise
  proxy.server.clearRequestHandler()
  release()

  const response = await pending
  assert.equal(response.status, 203)
  assert.equal(await response.text(), 'late')

  const next = await fetch(`http://127.0.0.1:${proxy.port}/`)
  assert.equal(await next.text(), 'upstream')
})

test('stops cleanly with an in-flight handler', async () => {
  const upstream = await startUpstream((_req, res) => res.end('upstream'))
  onTestFinished(() => upstream.close())

  const proxy = await createProxy({
    handlerTimeoutMs: 1000,
    shutdownTimeoutMs: 1000,
    routes: [{ pathPrefix: '/', upstreams: [`127.0.0.1:${upstream.port}`] }],
  })
  onTestFinished(() => proxy.stop())
  await waitForProxy(`http://127.0.0.1:${proxy.port}/`)

  let entered
  let release
  const enteredPromise = new Promise((resolve) => {
    entered = resolve
  })
  const gate = new Promise((resolve) => {
    release = resolve
  })

  proxy.server.setRequestHandler(async () => {
    entered()
    await gate
    return { action: 'continue' }
  })

  const pending = fetch(`http://127.0.0.1:${proxy.port}/slow`).catch((error) => error)
  await enteredPromise
  const stopping = proxy.stop()
  release()
  await stopping
  await pending
  assert.equal(proxy.server.status().state, 'stopped')
})


test('does not keep the event loop alive after stop', async () => {
  const port = await freePort()
  const script = `
    const { Server } = require('./index.js')
    const server = new Server({
      listeners: ['127.0.0.1:' + process.env.PORT],
      logLevel: 'off',
    })
    server.setRequestHandler(async () => ({ action: 'continue' }))
    server.start()
    setTimeout(() => server.stop(), 50)
  `
  const child = spawn(process.execPath, ['-e', script], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(port) },
    stdio: 'ignore',
  })
  const result = await Promise.race([
    once(child, 'exit'),
    delay(5_000).then(() => null),
  ])
  if (!result) {
    child.kill('SIGKILL')
    assert.fail('process did not exit after server.stop()')
  }
  assert.equal(result[0], 0)
})

test('joins repeated request headers in the view', async () => {
  const upstream = await startUpstream((_req, res) => res.end('upstream'))
  onTestFinished(() => upstream.close())

  const proxy = await createProxy({
    routes: [{ pathPrefix: '/', upstreams: [`127.0.0.1:${upstream.port}`] }],
  })
  onTestFinished(() => proxy.stop())
  await waitForProxy(`http://127.0.0.1:${proxy.port}/`)

  let seen
  proxy.server.setRequestHandler(async (request) => {
    seen = request
    return { action: 'respond', body: 'ok' }
  })

  await new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port: proxy.port,
        path: '/',
        headers: { 'x-repeat': ['one', 'two'] },
      },
      (response) => {
        response.resume()
        response.on('end', resolve)
      },
    )
    request.on('error', reject)
    request.end()
  })

  assert.equal(seen.headers['x-repeat'], 'one, two')
})

test('exposes non-UTF8 request header values lossily', async () => {
  const upstream = await startUpstream((_req, res) => res.end('upstream'))
  onTestFinished(() => upstream.close())

  const proxy = await createProxy({
    routes: [{ pathPrefix: '/', upstreams: [`127.0.0.1:${upstream.port}`] }],
  })
  onTestFinished(() => proxy.stop())
  await waitForProxy(`http://127.0.0.1:${proxy.port}/`)

  let seen
  proxy.server.setRequestHandler(async (request) => {
    seen = request
    return { action: 'respond', body: 'ok' }
  })

  await new Promise((resolve, reject) => {
    const socket = net.connect(proxy.port, '127.0.0.1', () => {
      socket.write(
        Buffer.concat([
          Buffer.from('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nx-internal: '),
          Buffer.from([0x80]),
          Buffer.from('\r\nConnection: close\r\n\r\n'),
        ]),
      )
    })
    socket.on('data', () => {})
    socket.on('end', resolve)
    socket.on('error', reject)
  })

  assert.ok(seen.headers['x-internal'].includes('\uFFFD'))
})

test('does not crash on malformed header mutations', async () => {
  const upstream = await startUpstream((_req, res) => res.end('upstream'))
  onTestFinished(() => upstream.close())

  const proxy = await createProxy({
    routes: [{ pathPrefix: '/', upstreams: [`127.0.0.1:${upstream.port}`] }],
  })
  onTestFinished(() => proxy.stop())
  await waitForProxy(`http://127.0.0.1:${proxy.port}/`)

  proxy.server.setRequestHandler(async () => ({
    action: 'continue',
    removeRequestHeaders: ['bad header'],
  }))
  const removeResponse = await fetch(`http://127.0.0.1:${proxy.port}/remove`)
  assert.equal(removeResponse.status, 200)

  proxy.server.setRequestHandler(async () => ({
    action: 'continue',
    requestHeaders: { 'bad header': 'value' },
  }))
  const insertResponse = await fetch(`http://127.0.0.1:${proxy.port}/insert`)
  assert.ok([500, 502].includes(insertResponse.status))

  proxy.server.clearRequestHandler()
  const alive = await fetch(`http://127.0.0.1:${proxy.port}/alive`)
  assert.equal(alive.status, 200)
  assert.equal(await alive.text(), 'upstream')
})
