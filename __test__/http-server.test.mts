import assert from 'node:assert/strict'
import net from 'node:net'

import { onTestFinished, test } from 'vitest'

import { createServer } from '@pingora/http-server'
import { freePort } from './helpers.mjs'


test('rejects invalid body limits', () => {
  for (const maxRequestBodyBytes of [0, -1, 1.5, Infinity, NaN, 0x1_0000_0000]) {
    assert.throws(
      () => createServer({ listen: 3000, maxRequestBodyBytes, handler: () => ({ body: 'x' }) }),
      /maxRequestBodyBytes/,
    )
  }
})

test('rejects invalid ports', () => {
  for (const listen of [0, 65536, '3000', ':3000']) {
    assert.throws(
      () => createServer({ listen, handler: () => ({ body: 'x' }) }),
      /listen/,
    )
  }
})

test('stops the native server when the listener cannot start', async () => {
  const port = await freePort()
  const blocker = await new Promise<net.Server>((resolve, reject) => {
    const socket = net.createServer()
    socket.once('error', reject)
    socket.listen(port, '127.0.0.1', () => resolve(socket))
  })
  const app = createServer({
    listen: port,
    handler: () => ({ body: 'ok' }),
  })
  onTestFinished(() => app.close())

  try {
    await assert.rejects(app.start())
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()))
  }

  await app.start()
  const response = await fetch(`http://127.0.0.1:${port}/`)
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'ok')
})

test('restarts after stop and after a failed start', async () => {
  const port = await freePort()
  const app = createServer({
    listen: port,
    handler: () => ({ body: 'ok' }),
  })
  onTestFinished(() => app.close())

  await app.start()
  await assert.rejects(app.start(), /already been started/)
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'ok')
  await app.stop()
  await app.start()
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'ok')
  await app.close()
})

test('does not let an idle stop clear a later start', async () => {
  const port = await freePort()
  const app = createServer({
    listen: port,
    handler: () => ({ body: 'ok' }),
  })
  onTestFinished(() => app.close())

  const idleStop = app.stop()
  await app.start()
  await idleStop
  await app.stop()
  await app.start()
  await app.close()
})

test('starts on a free port and serves GET and POST', async () => {
  const port = await freePort()
  const app = createServer({
    listen: port,
    maxRequestBodyBytes: 1024,
    handler: async (request) => ({
      action: 'continue',
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
})
