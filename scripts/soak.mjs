import http from 'node:http'
import net from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

import { Server } from '../index.js'

const durationMs = Number(process.env.SOAK_DURATION_MS ?? 10_000)
const concurrency = Number(process.env.SOAK_CONCURRENCY ?? 8)
const deadline = Date.now() + durationMs
const failures = []

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
}

async function freePort() {
  const probe = net.createServer()
  await listen(probe)
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  return port
}

function request(port, path = '/') {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.once('error', reject)
  })
}

async function waitForProxy(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await request(port)
      return
    } catch {
      await delay(20)
    }
  }
  throw new Error('proxy did not become ready')
}

async function main() {
  const origin = http.createServer((_req, res) => res.end('ok'))
  await listen(origin)
  const port = await freePort()
  const server = new Server({
    listeners: [`127.0.0.1:${port}`],
    routes: [
      { id: 'soak', pathPrefix: '/', upstreams: [`127.0.0.1:${origin.address().port}`] },
    ],
    gracePeriodMs: 0,
    shutdownTimeoutMs: 500,
    maxRequestBodyBytes: 1024 * 1024,
    maxRequestHeaders: 64,
    handlerTimeoutMs: 200,
    logLevel: 'off',
  })

  server.start()
  await waitForProxy(port)

  let requests = 0
  let routeAdds = 0
  let handlerToggles = 0
  const workers = Array.from({ length: concurrency }, async () => {
    while (Date.now() < deadline) {
      try {
        const status = await request(port, requests % 5 === 0 ? '/missing' : '/')
        if (status !== 200 && status !== 404) failures.push(`status ${status}`)
        requests += 1
      } catch (error) {
        failures.push(String(error))
      }
    }
  })

  const churn = (async () => {
    let index = 0
    while (Date.now() < deadline) {
      try {
        server.addRoute({
          id: `churn-${index}`,
          pathPrefix: `/churn-${index}`,
          upstreams: [`127.0.0.1:${origin.address().port}`],
        })
        server.removeRoute(`churn-${index}`)
        routeAdds += 1
        if (index % 2 === 0) {
          server.setRequestHandler(async () => ({ action: 'continue' }))
        } else {
          server.clearRequestHandler()
        }
        handlerToggles += 1
        index += 1
      } catch (error) {
        failures.push(String(error))
      }
      await delay(10)
    }
  })()

  await Promise.all([...workers, churn])
  server.clearRequestHandler()
  await server.stop()
  await new Promise((resolve) => origin.close(resolve))

  console.log(
    JSON.stringify({
      durationMs,
      concurrency,
      requests,
      routeAdds,
      handlerToggles,
      failures: failures.slice(0, 10),
    }),
  )
  if (failures.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
