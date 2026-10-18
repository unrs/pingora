import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import http2 from 'node:http2'
import https from 'node:https'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { onTestFinished, test } from 'vitest'

import { Server } from '../index.js'
import { freePort, startUpstream, waitForProxy } from './helpers.mjs'

const cert = fileURLToPath(new URL('./fixtures/cert.pem', import.meta.url))
const key = fileURLToPath(new URL('./fixtures/key.pem', import.meta.url))
const ca = readFileSync(cert)

function httpsRequest(port, path = '/') {
  return new Promise((resolve, reject) => {
    const request = https.request(
      { host: '127.0.0.1', port, path, ca },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            httpVersion: response.httpVersion,
            headers: response.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        )
      },
    )
    request.once('error', reject)
    request.end()
  })
}

async function waitForHttps(port, path = '/') {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await httpsRequest(port, path)
    } catch {
      await delay(50)
    }
  }
  throw new Error(`TLS proxy at ${port} did not become ready`)
}

function http2Request(port, path = '/') {
  const client = http2.connect(`https://127.0.0.1:${port}`, { ca })
  return new Promise((resolve, reject) => {
    const request = client.request({ ':path': path })
    let headers
    const chunks = []
    request.on('response', (value) => {
      headers = value
    })
    request.setEncoding('utf8')
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      client.close()
      resolve({
        status: headers?.[':status'],
        body: chunks.join(''),
        alpn: client.alpnProtocol,
      })
    })
    request.once('error', (error) => {
      client.close()
      reject(error)
    })
    request.end()
  })
}

async function createTlsProxy(options) {
  const port = await freePort()
  const server = new Server({
    listeners: [
      {
        address: `127.0.0.1:${port}`,
        tls: { cert, key },
      },
    ],
    gracePeriodMs: 0,
    shutdownTimeoutMs: 0,
    logLevel: 'off',
    ...options,
  })
  server.start()
  return { server, port, stop: () => server.stop() }
}

test('terminates TLS and negotiates HTTP/1.1', async () => {
  const upstream = await startUpstream((_req, res) => res.end('upstream'))
  onTestFinished(() => upstream.close())

  const proxy = await createTlsProxy({
    routes: [{ pathPrefix: '/', upstreams: [`127.0.0.1:${upstream.port}`] }],
  })
  onTestFinished(() => proxy.stop())

  const response = await waitForHttps(proxy.port)
  assert.equal(response.status, 200)
  assert.equal(response.body, 'upstream')
  assert.equal(response.httpVersion, '1.1')
})

test('negotiates HTTP/2 over TLS and exposes https to the handler', async () => {
  const upstream = await startUpstream((_req, res) => res.end('upstream'))
  onTestFinished(() => upstream.close())

  const proxy = await createTlsProxy({
    routes: [{ pathPrefix: '/', upstreams: [`127.0.0.1:${upstream.port}`] }],
  })
  onTestFinished(() => proxy.stop())

  proxy.server.setRequestHandler(async (request) => ({
    action: 'respond',
    status: 200,
    body: request.scheme,
  }))

  await waitForHttps(proxy.port)
  let response
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      response = await http2Request(proxy.port)
      break
    } catch {
      await delay(50)
    }
  }
  assert.ok(response)
  assert.equal(response.status, 200)
  assert.equal(response.alpn, 'h2')
  assert.equal(response.body, 'https')
})

test('rejects invalid TLS certificate paths at start', async () => {
  const port = await freePort()
  const server = new Server({
    listeners: [
      {
        address: `127.0.0.1:${port}`,
        tls: { cert: '/missing/cert.pem', key: '/missing/key.pem' },
      },
    ],
    logLevel: 'off',
  })
  assert.throws(() => server.start(), /TLS|certificate/)
})

test('supports plain and TLS listeners together', async () => {
  const upstream = await startUpstream((_req, res) => res.end('upstream'))
  onTestFinished(() => upstream.close())

  const plainPort = await freePort()
  const tlsPort = await freePort()
  const server = new Server({
    listeners: [
      `127.0.0.1:${plainPort}`,
      { address: `127.0.0.1:${tlsPort}`, tls: { cert, key } },
    ],
    routes: [{ pathPrefix: '/', upstreams: [`127.0.0.1:${upstream.port}`] }],
    gracePeriodMs: 0,
    shutdownTimeoutMs: 0,
    logLevel: 'off',
  })
  server.start()
  onTestFinished(() => server.stop())

  const plain = await waitForProxy(`http://127.0.0.1:${plainPort}/`)
  assert.equal(await plain.text(), 'upstream')
  const secure = await waitForHttps(tlsPort)
  assert.equal(secure.body, 'upstream')
})
