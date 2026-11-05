import assert from 'node:assert/strict'
import net from 'node:net'
import vm from 'node:vm'

import { onTestFinished, test } from 'vitest'
import { Server } from '../index.js'

import { createServer } from '@pingora/http-server'
import { freePort, startUpstream } from './helpers.js'

async function occupy(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const socket = net.createServer()
    socket.once('error', reject)
    socket.listen(port, '127.0.0.1', () => resolve(socket))
  })
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

test('rejects invalid body limits', () => {
  for (const maxRequestBodyBytes of [0, -1, 1.5, Infinity, NaN, 0x1_0000_0000]) {
    assert.throws(
      () => createServer({ listen: 3000, maxRequestBodyBytes, handler: () => ({ body: 'x' }) }),
      /maxRequestBodyBytes/,
    )
  }
})

test('rejects invalid ports', () => {
  for (const listen of [0, 65536, '3000', ':3000', 'unix:', 'http://127.0.0.1:3000', '::1:3000']) {
    assert.throws(
      () => createServer({ listen, handler: () => ({ body: 'x' }) }),
      /listen/,
    )
  }
})

test('retries after a failed start', async () => {
  const port = await freePort()
  const blocker = await occupy(port)
  onTestFinished(() => closeServer(blocker))
  const app = createServer({ listen: port, handler: () => ({ body: 'ok' }) })
  onTestFinished(() => app.close())

  await assert.rejects(app.start())
  await closeServer(blocker)

  await app.start()
  const response = await fetch(`http://127.0.0.1:${port}/`)
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'ok')
})

test('restarts after close', async () => {
  const port = await freePort()
  const app = createServer({ listen: port, handler: () => ({ body: 'ok' }) })
  onTestFinished(() => app.close())

  await app.start()
  await assert.rejects(app.start(), /already been started/)
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'ok')
  await app.close()
  await app.close()

  await app.start()
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'ok')
  await app.close()
})

test('delegates native start and stop through the facade', async () => {
  const port = await freePort()
  const app = createServer({ listen: port, handler: () => ({ body: 'ok' }) })
  onTestFinished(() => app.close())

  assert.equal(app.server instanceof Server, true)
  assert.equal(app.server.constructor, Server)
  await app.server.start()
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'ok')
  await app.server.stop()
  await app.start()
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'ok')
  await app.close()
})

test('rejects close while start is in progress', async () => {
  const port = await freePort()
  const blocker = await occupy(port)
  onTestFinished(() => closeServer(blocker))
  const app = createServer({ listen: port, handler: () => ({ body: 'ok' }) })
  onTestFinished(() => app.close())

  const starting = app.start()
  await assert.rejects(app.close(), /starting/)
  await assert.rejects(starting)
  await closeServer(blocker)
})

test('serves GET, POST, and rejects an over-limit body', async () => {
  const port = await freePort()
  const app = createServer({
    listen: port,
    maxRequestBodyBytes: 1024,
    handler: async (request) => ({
      status: 200,
      headers: { 'x-method': request.method },
      body: request.body?.length ? request.body : 'empty',
    }),
  })
  onTestFinished(() => app.close())

  await app.start()
  const get = await fetch(`${app.url}/`)
  assert.equal(get.status, 200)
  assert.equal(get.headers.get('x-method'), 'GET')
  assert.equal(await get.text(), 'empty')

  const post = await fetch(`${app.url}/`, { method: 'POST', body: 'payload' })
  assert.equal(post.status, 200)
  assert.equal(await post.text(), 'payload')

  const tooLarge = await fetch(`${app.url}/`, {
    method: 'POST',
    body: 'x'.repeat(2048),
  })
  assert.equal(tooLarge.status, 413)
})

test('serves native routes without invoking the handler', async () => {
  const port = await freePort()
  let calls = 0
  const app = createServer({
    listen: port,
    routes: [
      {
        path: '/native',
        respond: { headers: { 'content-type': 'text/plain' }, body: 'native' },
      },
    ],
    handler: () => {
      calls += 1
      return { body: 'js' }
    },
  })
  onTestFinished(() => app.close())

  await app.start()
  const native = await fetch(`http://127.0.0.1:${port}/native`)
  assert.equal(native.status, 200)
  assert.equal(native.headers.get('content-type'), 'text/plain')
  assert.equal(await native.text(), 'native')
  assert.equal(calls, 0)

  const dynamic = await fetch(`http://127.0.0.1:${port}/dynamic`)
  assert.equal(await dynamic.text(), 'js')
  assert.equal(calls, 1)
})

test('starts with only native routes', async () => {
  const port = await freePort()
  const app = createServer({
    listen: port,
    routes: [{ path: '/native', respond: { body: 'native' } }],
  })
  onTestFinished(() => app.close())

  await app.start()
  const response = await fetch(`http://127.0.0.1:${port}/native`)
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'native')
})


test('does not call the fallback handler for matched upstream routes', async () => {
  const upstream = await startUpstream((_request, response) => response.end('upstream'))
  onTestFinished(() => upstream.close())
  const port = await freePort()
  let calls = 0
  const app = createServer({
    listen: port,
    routes: [{ path: '/proxy', upstreams: [`127.0.0.1:${upstream.port}`] }],
    handler: () => {
      calls += 1
      return { body: 'js' }
    },
  })
  onTestFinished(() => app.close())

  await app.start()
  const proxied = await fetch(`http://127.0.0.1:${port}/proxy`)
  assert.equal(await proxied.text(), 'upstream')
  assert.equal(calls, 0)

  const fallback = await fetch(`http://127.0.0.1:${port}/other`)
  assert.equal(await fallback.text(), 'js')
  assert.equal(calls, 1)
})


test('keeps the handler for routes added at runtime to a handler-only server', async () => {
  const upstream = await startUpstream((_request, response) => response.end('upstream'))
  onTestFinished(() => upstream.close())
  const port = await freePort()
  let calls = 0
  const app = createServer({
    listen: port,
    handler: () => {
      calls += 1
      return { body: 'js' }
    },
  })
  onTestFinished(() => app.close())
  app.server.addRoute({ path: '/runtime', upstreams: [`127.0.0.1:${upstream.port}`] })

  await app.start()
  const response = await fetch(`http://127.0.0.1:${port}/runtime`)
  assert.equal(await response.text(), 'js')
  assert.equal(calls, 1)
})

test('accepts thenables from another realm', async () => {
  const port = await freePort()
  const app = createServer({
    listen: port,
    handler: () =>
      vm.runInNewContext('Promise.resolve({ body: "vm" })') as PromiseLike<{
        body: string
      }>,
  })
  onTestFinished(() => app.close())

  await app.start()
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'vm')
})

test('serves native status, headers, binary body, and HEAD', async () => {
  const port = await freePort()
  const app = createServer({
    listen: port,
    routes: [
      {
        path: '/native',
        respond: {
          status: 201,
          headers: { 'x-native': 'yes', 'content-type': 'application/octet-stream' },
          body: Buffer.from([0, 1, 255]),
        },
      },
    ],
  })
  onTestFinished(() => app.close())

  await app.start()
  const response = await fetch(`http://127.0.0.1:${port}/native`)
  assert.equal(response.status, 201)
  assert.equal(response.headers.get('x-native'), 'yes')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from([0, 1, 255]))

  const head = await fetch(`http://127.0.0.1:${port}/native`, { method: 'HEAD' })
  assert.equal(head.status, 201)
  assert.equal(head.headers.get('content-length'), '3')
  assert.equal(await head.text(), '')
})

test('rejects invalid native route configuration', async () => {
  const port = await freePort()
  assert.throws(
    () => createServer({ listen: port }),
    /requires a handler function or at least one route/,
  )

  const missingTarget = createServer({ listen: port, routes: [{ path: '/' }] })
  await assert.rejects(missingTarget.start(), /at least one upstream or a respond body/)

  const badStatus = createServer({
    listen: port,
    routes: [{ path: '/', respond: { status: 600 } }],
  })
  await assert.rejects(badStatus.start(), /invalid respond status/)

  const both = createServer({
    listen: port,
    routes: [{ path: '/', respond: { body: 'ok' }, upstreams: ['127.0.0.1:1'] }],
  })
  await assert.rejects(both.start(), /cannot combine respond with upstreams/)
})
