import http from 'node:http'
import net from 'node:net'

import { Server } from '../index.js'

const MAX_FAILURE_SAMPLES = 10

function positiveInteger(name, value) {
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${name} must be a positive integer, got ${value}`)
  }
  return number
}

const durationMs = positiveInteger('SOAK_DURATION_MS', process.env.SOAK_DURATION_MS ?? 10_000)
const concurrency = positiveInteger('SOAK_CONCURRENCY', process.env.SOAK_CONCURRENCY ?? 8)
const cycles = positiveInteger('SOAK_CYCLES', process.env.SOAK_CYCLES ?? 1)
const cycleDurationMs = Math.max(1, Math.floor(durationMs / cycles))
const failures = []
let failureCount = 0
let requests = 0
let routeAdds = 0
let handlerToggles = 0

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function recordFailure(error) {
  failureCount += 1
  if (failures.length < MAX_FAILURE_SAMPLES) failures.push(String(error))
}

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

function request(port, path, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error, status) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve(status)
    }
    const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
      res.once('error', (error) => finish(error))
      res.resume()
      res.once('end', () => finish(null, res.statusCode))
    })
    req.once('error', (error) => finish(error))
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`request timeout after ${timeoutMs}ms: ${path}`))
    })
  })
}

async function waitForProxy(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const status = await request(port, '/ok', 500)
      if (status === 200) return
    } catch {}
    await delay(20)
  }
  throw new Error('proxy did not become ready')
}

async function runCycle(origin, cycle) {
  const port = await freePort()
  const server = new Server({
    listeners: [`127.0.0.1:${port}`],
    routes: [
      { id: 'soak', path: '/ok', upstreams: [`127.0.0.1:${origin.address().port}`] },
    ],
    gracePeriodMs: 0,
    shutdownTimeoutMs: 500,
    maxRequestBodyBytes: 1024 * 1024,
    maxRequestHeaders: 64,
    handlerTimeoutMs: 200,
    logLevel: 'off',
  })

  try {
    server.start()
    await waitForProxy(port)
    const deadline = Date.now() + cycleDurationMs

    const workers = Array.from({ length: concurrency }, async () => {
      while (Date.now() < deadline) {
        const path = requests % 5 === 0 ? '/no-route' : '/ok'
        try {
          const status = await request(port, path)
          const expected = path === '/no-route' ? 404 : 200
          if (status !== expected) recordFailure(`status ${status} for ${path}`)
          requests += 1
        } catch (error) {
          recordFailure(error)
        }
      }
    })

    const churn = (async () => {
      let index = 0
      while (Date.now() < deadline) {
        const id = `churn-${cycle}-${index}`
        try {
          server.addRoute({
            id,
            pathPrefix: `/${id}`,
            upstreams: [`127.0.0.1:${origin.address().port}`],
          })
          routeAdds += 1
          const present = await request(port, `/${id}`)
          if (present !== 200) recordFailure(`new route ${id} returned ${present}`)

          server.removeRoute(id)
          const removed = await request(port, `/${id}`)
          if (removed !== 404) recordFailure(`removed route ${id} returned ${removed}`)

          index += 1
          if (index % 2 === 0) {
            server.setRequestHandler(async () => ({ action: 'continue' }))
          } else {
            server.clearRequestHandler()
          }
          handlerToggles += 1
        } catch (error) {
          recordFailure(error)
          server.removeRoute(id)
        }
        await delay(10)
      }
    })()

    await Promise.all([...workers, churn])
  } finally {
    server.clearRequestHandler()
    await server.stop()
  }
}

async function main() {
  const origin = http.createServer((_req, res) => res.end('ok'))
  await listen(origin)
  try {
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      await runCycle(origin, cycle)
    }
  } finally {
    origin.closeAllConnections?.()
    await new Promise((resolve) => origin.close(resolve))
  }

  console.log(
    JSON.stringify({
      durationMs,
      concurrency,
      cycles,
      requests,
      routeAdds,
      handlerToggles,
      failureCount,
      failures,
    }),
  )
  if (failureCount > 0) process.exitCode = 1
}

main().catch((error) => {
  recordFailure(error)
  console.error(error)
  process.exitCode = 1
})
