import http from 'node:http'
import net from 'node:net'

import { Server } from '../index.js'

const threshold = Number(process.env.BENCH_GATE_THRESHOLD ?? 0.1)
if (!Number.isFinite(threshold) || threshold <= 0) {
  throw new Error(`BENCH_GATE_THRESHOLD must be a finite positive number, got ${process.env.BENCH_GATE_THRESHOLD}`)
}
const durationMs = Number(process.env.BENCH_GATE_DURATION_MS ?? 1_000)
if (!Number.isFinite(durationMs) || durationMs <= 0) {
  throw new Error(`BENCH_GATE_DURATION_MS must be a finite positive number, got ${process.env.BENCH_GATE_DURATION_MS}`)
}
const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })

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

function request(port, path = '/', timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    let settled = false
    let deadline
    const finish = (error, status) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      if (error) reject(error)
      else resolve(status)
    }
    const req = http.get({ host: '127.0.0.1', port, path, agent }, (res) => {
      res.resume()
      res.once('end', () => finish(null, res.statusCode))
      res.once('error', (error) => finish(error))
    })
    req.once('error', (error) => finish(error))
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`benchmark request inactivity timeout after ${timeoutMs}ms`))
    })
    deadline = setTimeout(() => {
      req.destroy(new Error(`benchmark request deadline after ${timeoutMs}ms`))
    }, timeoutMs)
  })
}

async function waitFor(port, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    try {
      if ((await request(port, '/', Math.min(500, remaining))) === 200) return
    } catch {}
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(20, Math.max(0, deadline - Date.now()))),
    )
  }
  throw new Error('benchmark proxy did not become ready')
}

async function throughput(port, milliseconds) {
  const deadline = Date.now() + milliseconds
  let count = 0
  while (Date.now() < deadline) {
    const status = await request(port)
    if (status !== 200) throw new Error(`unexpected status ${status}`)
    count += 1
  }
  return count
}

async function main() {
  const origin = http.createServer((_req, res) => res.end('ok'))
  await listen(origin)
  let server
  try {
    const proxyPort = await freePort()
    server = new Server({
      listeners: [`127.0.0.1:${proxyPort}`],
      routes: [{ path: '/', upstreams: [`127.0.0.1:${origin.address().port}`] }],
      gracePeriodMs: 0,
      shutdownTimeoutMs: 500,
      logLevel: 'off',
    })
    server.start()
    await waitFor(proxyPort)
    await throughput(origin.address().port, 200)
    await throughput(proxyPort, 200)

    const direct = await throughput(origin.address().port, durationMs)
    const proxied = await throughput(proxyPort, durationMs)
    const ratio = direct === 0 ? 0 : proxied / direct
    const result = { direct, proxied, ratio, threshold, durationMs }
    console.log(JSON.stringify(result))
    if (!Number.isFinite(ratio) || ratio < threshold) {
      console.error(`performance gate failed: ratio ${ratio.toFixed(3)} < ${threshold}`)
      process.exitCode = 1
    }
  } finally {
    agent.destroy()
    await server?.stop()
    origin.closeAllConnections?.()
    await new Promise((resolve) => origin.close(resolve))
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
