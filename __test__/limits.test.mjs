import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'vitest'

import { Server } from '../index.js'
import { createProxy, request, startUpstream, waitForProxy } from './helpers.mjs'

async function proxyWith(upstream, options = {}) {
  const proxy = await createProxy({
    routes: [{ pathPrefix: '/', upstreams: [`127.0.0.1:${upstream.port}`] }],
    ...options,
  })
  await waitForProxy(`http://127.0.0.1:${proxy.port}/`)
  return proxy
}

test('rejects too many request headers with 431', async () => {
  const upstream = await startUpstream((_req, res) => res.end('ok'))
  const proxy = await proxyWith(upstream, { maxRequestHeaders: 2 })
  try {
    const response = await request(`http://127.0.0.1:${proxy.port}/`, {
      headers: { 'x-a': '1', 'x-b': '2', 'x-c': '3' },
    })
    assert.equal(response.status, 431)
  } finally {
    await proxy.stop()
    await upstream.close()
  }
})

test('rejects oversized request headers with 431', async () => {
  const upstream = await startUpstream((_req, res) => res.end('ok'))
  const proxy = await proxyWith(upstream, { maxRequestHeaderBytes: 20 })
  try {
    const response = await request(`http://127.0.0.1:${proxy.port}/`, {
      headers: { 'x-large': 'x'.repeat(100) },
    })
    assert.equal(response.status, 431)
  } finally {
    await proxy.stop()
    await upstream.close()
  }
})

function chunkedRequest(url, body) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      url,
      { method: 'POST', headers: { 'transfer-encoding': 'chunked' } },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () =>
          resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }),
        )
      },
    )
    request.once('error', reject)
    request.write(body)
    request.end()
  })
}

test('rejects a chunked request body over the limit', async () => {
  const upstream = await startUpstream((_req, res) => res.end('ok'))
  const proxy = await proxyWith(upstream, { maxRequestBodyBytes: 4 })
  try {
    const response = await chunkedRequest(`http://127.0.0.1:${proxy.port}/`, '12345')
    assert.equal(response.status, 413)
  } finally {
    await proxy.stop()
    await upstream.close()
  }
})

test('rejects a declared request body over the limit with 413', async () => {
  const upstream = await startUpstream((_req, res) => res.end('ok'))
  const proxy = await proxyWith(upstream, { maxRequestBodyBytes: 4 })
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/`, {
      method: 'POST',
      body: '12345',
    })
    assert.equal(response.status, 413)
  } finally {
    await proxy.stop()
    await upstream.close()
  }
})

test('enforces maxRoutes', async () => {
  const upstream = await startUpstream((_req, res) => res.end('ok'))
  const proxy = await proxyWith(upstream, { maxRoutes: 1 })
  try {
    assert.throws(
      () =>
        proxy.server.addRoute({
          pathPrefix: '/other',
          upstreams: [`127.0.0.1:${upstream.port}`],
        }),
      /maxRoutes/,
    )
  } finally {
    await proxy.stop()
    await upstream.close()
  }
})

test('enforces maxListeners', async () => {
  const server = new Server({
    listeners: ['127.0.0.1:0', '127.0.0.1:0'],
    maxListeners: 1,
    logLevel: 'off',
  })
  assert.throws(() => server.start(), /maxListeners/)
})
