import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { onTestFinished, test } from 'vitest'

import { createProxy, waitForProxy } from './helpers.mjs'

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const KEY = 'dGhlIHNhbXBsZSBub25jZQ=='

function acceptValue(key) {
  return createHash('sha1').update(key + WEBSOCKET_GUID).digest('base64')
}

async function startUpgradeUpstream() {
  const server = http.createServer((_req, res) => res.end('http'))
  const sockets = new Set()
  server.on('upgrade', (req, socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    const accept = acceptValue(req.headers['sec-websocket-key'])
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n'),
    )
    socket.write('hello')
    socket.on('data', (chunk) => socket.write(chunk))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

async function waitForData(read, predicate, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate(read())) return
    await delay(10)
  }
  throw new Error(`timed out waiting for ${label}`)
}

test('passes WebSocket upgrades through to the upstream', async () => {
  const upstream = await startUpgradeUpstream()
  const proxy = await createProxy({
    shutdownTimeoutMs: 100,
    routes: [{ pathPrefix: '/', upstreams: [`127.0.0.1:${upstream.port}`] }],
  })

  await waitForProxy(`http://127.0.0.1:${proxy.port}/`)

  const socket = net.connect(proxy.port, '127.0.0.1')
  let received = Buffer.alloc(0)
  socket.on('data', (chunk) => {
    received = Buffer.concat([received, chunk])
  })

  try {
    await once(socket, 'connect')
    socket.on('error', () => {})

    socket.write(
      [
        'GET /ws HTTP/1.1',
        `Host: 127.0.0.1:${proxy.port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${KEY}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n'),
    )

    await waitForData(
      () => received.toString(),
      (value) => value.startsWith('HTTP/1.1 101') && value.includes('hello'),
      'upgrade response',
    )
    assert.ok(received.toString().includes(`Sec-WebSocket-Accept: ${acceptValue(KEY)}`))

    socket.write('ping')
    await waitForData(
      () => received.toString(),
      (value) => value.includes('ping'),
      'echoed payload',
    )
  } finally {
    socket.destroy()
    await proxy.stop()
    upstream.close()
  }
})
