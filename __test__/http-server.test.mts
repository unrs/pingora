import assert from 'node:assert/strict'

import { onTestFinished, test } from 'vitest'

import { createServer } from '@pingora/http-server'
import { freePort } from './helpers.mjs'


test('rejects port 0', () => {
  assert.throws(() => createServer({ listen: 0, handler: () => ({ body: 'x' }) }), /positive integer/)
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
