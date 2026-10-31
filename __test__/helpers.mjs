import http from 'node:http'
import net from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

import { Server } from '../index.js'

export async function freePort() {
  const probe = net.createServer()
  await new Promise((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  return port
}

export async function startUpstream(handler, port = 0) {
  const server = http.createServer(handler)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

export async function waitForProxy(url) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await fetch(url)
    } catch {
      await delay(50)
    }
  }
  throw new Error(`proxy at ${url} did not become ready`)
}

export async function eventually(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await predicate()
    if (value) return value
    await delay(10)
  }
  throw new Error(message)
}

export function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString(),
        }),
      )
    })
    req.once('error', reject)
    req.end()
  })
}

export async function createProxy(options = {}) {
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
