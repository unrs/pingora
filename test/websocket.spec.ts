import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'vitest'

import { createProxy, waitForProxy } from './helpers.js'

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const KEY = 'dGhlIHNhbXBsZSBub25jZQ=='

function acceptValue(key: string) {
  return createHash('sha1').update(key + WEBSOCKET_GUID).digest('base64')
}

async function startUpgradeUpstream() {
  const server = http.createServer((_req, res) => res.end('http'))
  const sockets = new Set<Duplex>()
  server.on('upgrade', (req, socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    const key = req.headers['sec-websocket-key']
    if (typeof key !== 'string') {
      socket.destroy()
      return
    }
    const accept = acceptValue(key)
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
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  return {
    port: (server.address() as AddressInfo).port,
    close: () => {
      for (const socket of sockets) socket.destroy()
      server.closeAllConnections?.()
      return new Promise((resolve) => server.close(resolve))
    },
  }
}

async function waitForData(
  read: () => string,
  predicate: (value: string) => boolean,
  label: string,
) {
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
    maxRequestBodyBytes: 1,
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
    const handshakeEnd = received.indexOf('\r\n\r\n') + 4
    const handshakeLines = received.subarray(0, handshakeEnd).toString().split('\r\n')
    assert.ok(handshakeLines.some((line) => /^upgrade:\s*websocket$/i.test(line)))
    assert.ok(handshakeLines.some((line) => /^connection:\s*upgrade$/i.test(line)))
    const acceptLine = handshakeLines.find((line) => /^sec-websocket-accept:/i.test(line))
    assert.ok(acceptLine)
    assert.equal(acceptLine.slice(acceptLine.indexOf(':') + 1).trim(), acceptValue(KEY))

    socket.write('ping')
    await waitForData(
      () => received.toString(),
      (value) => value.includes('ping'),
      'echoed payload',
    )
    assert.equal(received.subarray(handshakeEnd).toString(), 'helloping')
  } finally {
    socket.destroy()
    await proxy.stop()
    await upstream.close()
  }
})
