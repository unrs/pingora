import http from 'node:http'
import net from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, beforeAll, test } from 'vitest'
import httpProxy from 'http-proxy'
import { createProxyMiddleware } from 'http-proxy-middleware'

import { Server } from '../index.js'

const BATCH = 20
const COMPARE_OPTIONS = { time: 2_000, warmupTime: 500 }

const outboundAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 256,
  maxFreeSockets: 64,
})

const servers = []
let pingora
let upstreamPort
let pingoraPort
let httpProxyPort
let middlewarePort

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      servers.push(server)
      resolve(server.address().port)
    })
  })
}

function close(server) {
  return new Promise((resolve) => server.close(resolve))
}

async function freePort() {
  const probe = net.createServer()
  await new Promise((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  return port
}

function request(port) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/bench',
        agent: outboundAgent,
        headers: { connection: 'keep-alive' },
      },
      (response) => {
        response.resume()
        response.on('end', resolve)
      },
    )
    req.setTimeout(10_000, () => req.destroy(new Error('request timed out')))
    req.once('error', reject)
    req.end()
  })
}

async function waitFor(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await request(port)
      return
    } catch {
      await delay(50)
    }
  }
  throw new Error(`server on ${port} did not become ready`)
}

function concurrent(port) {
  return Promise.all(Array.from({ length: BATCH }, () => request(port)))
}

beforeAll(async () => {
  const upstream = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/plain')
    res.end('ok')
  })
  upstream.keepAliveTimeout = 60_000
  upstreamPort = await listen(upstream)

  const target = `http://127.0.0.1:${upstreamPort}`

  pingoraPort = await freePort()
  pingora = new Server({
    listeners: [`127.0.0.1:${pingoraPort}`],
    routes: [{ pathPrefix: '/', upstreams: [target] }],
    threads: 2,
    gracePeriodMs: 0,
    shutdownTimeoutMs: 0,
    logLevel: 'off',
  })
  pingora.start()
  await waitFor(pingoraPort)

  const httpProxyInstance = httpProxy.createProxyServer({
    target,
    agent: outboundAgent,
  })
  httpProxyInstance.on('error', (_error, _req, res) => {
    if (res && !res.headersSent) {
      res.statusCode = 502
      res.end()
    }
  })
  httpProxyPort = await listen(
    http.createServer((req, res) => {
      httpProxyInstance.web(req, res)
    }),
  )

  const middleware = createProxyMiddleware({
    target,
    changeOrigin: false,
    agent: outboundAgent,
  })
  middlewarePort = await listen(
    http.createServer((req, res) => {
      middleware(req, res, () => {
        res.statusCode = 404
        res.end()
      })
    }),
  )
})

afterAll(async () => {
  await pingora?.stop()
  await Promise.all(servers.map(close))
  outboundAgent.destroy()
})

test('single-request proxy comparison', async ({ bench }) => {
  await bench.compare(
    bench('direct upstream', () => request(upstreamPort)),
    bench('pingora', () => request(pingoraPort)),
    bench('http-proxy', () => request(httpProxyPort)),
    bench('http-proxy-middleware', () => request(middlewarePort)),
    COMPARE_OPTIONS,
  )
})

test(`${BATCH}-concurrent proxy comparison`, async ({ bench }) => {
  await bench.compare(
    bench('direct upstream', () => concurrent(upstreamPort)),
    bench('pingora', () => concurrent(pingoraPort)),
    bench('http-proxy', () => concurrent(httpProxyPort)),
    bench('http-proxy-middleware', () => concurrent(middlewarePort)),
    COMPARE_OPTIONS,
  )
})
