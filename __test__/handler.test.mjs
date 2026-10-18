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

test('passes a request view and returns a synthetic response', async () => {
  const upstream = await startUpstream((_req, res) => res.end('upstream'))
  onTestFinished(() => upstream.close())

  const proxy = await createProxy({
    routes: [{ id: 'app', pathPrefix: '/', upstreams: [`127.0.0.1:${upstream.port}`] }],
  })
  onTestFinished(() => proxy.stop())

  const seen = []
  proxy.server.setRequestHandler(async (request) => {
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

  const proxied = await waitForProxy(`http://127.0.0.1:${proxy.port}/other`)
  assert.equal(await proxied.text(), 'upstream')
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
    routes: [{ pathPrefix: '/', upstreams: [`127.0.0.1:${first.port}`] }],
  })
  onTestFinished(() => proxy.stop())
  await waitForProxy(`http://127.0.0.1:${proxy.port}/`)

  proxy.server.setRequestHandler(async (request) => {
    if (request.path === '/second') {
      return {
        action: 'upstream',
        upstream: `127.0.0.1:${second.port}`,
        requestHeaders: { 'x-handler': 'yes' },
        removeRequestHeaders: ['x-remove'],
        responseHeaders: { 'x-response': 'yes' },
        removeResponseHeaders: ['x-remove-response'],
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
  assert.equal(observed['x-handler'], 'yes')
  assert.equal(observed['x-remove'], undefined)
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

  proxy.server.setRequestHandler(async () => ({
    action: 'respond',
    status: 204,
    body: 'not allowed',
  }))
  assert.equal((await fetch(`http://127.0.0.1:${proxy.port}/no-body`)).status, 500)

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
