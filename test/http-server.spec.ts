import assert from 'node:assert/strict'
import net from 'node:net'

import { onTestFinished, test } from 'vitest'
import { Server } from '../index.js'

import { createServer } from '@pingora/http-server'
import { freePort } from './helpers.js'

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
