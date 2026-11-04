import http from 'node:http'
import type { AddressInfo } from 'node:net'
import net from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

import { Server } from '../index.js'

export async function freePort(): Promise<number> {
  const probe = net.createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })
  const address = probe.address()
  if (!address || typeof address === 'string') throw new Error('failed to allocate a TCP port')
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return address.port
}

export async function startUpstream(
  handler: http.RequestListener,
  port = 0,
): Promise<{
  port: number
  connection: Promise<net.Socket>
  close: () => Promise<void>
}> {
  const server = http.createServer(handler)
  const connection = new Promise<net.Socket>((resolve) => {
    server.once('connection', resolve)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return {
    port: address.port,
    connection,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

export async function waitForProxy(url: string, options?: RequestInit): Promise<Response> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await fetch(url, options)
    } catch {
      await delay(50)
    }
  }
  throw new Error(`proxy at ${url} did not become ready`)
}

export async function eventually<T>(
  predicate: () => T | Promise<T>,
  message?: string,
): Promise<NonNullable<T>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await predicate()
    if (value) return value as NonNullable<T>
    await delay(10)
  }
  throw new Error(message)
}

export function request(
  url: string,
  options: http.RequestOptions = {},
): Promise<{
  status: number | undefined
  headers: http.IncomingHttpHeaders
  body: string
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
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

export async function createProxy(options: Record<string, unknown> = {}): Promise<{
  server: Server
  port: number
  stop: () => Promise<void>
}> {
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
