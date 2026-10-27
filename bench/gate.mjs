import http from 'node:http'
import net from 'node:net'

import { Server } from '../index.js'

const threshold = Number(process.env.BENCH_GATE_THRESHOLD ?? 0.1)
const durationMs = Number(process.env.BENCH_GATE_DURATION_MS ?? 1_000)
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

function request(port, path = '/') {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, agent }, (res) => {
      res.resume()
      res.once('end', () => resolve(res.statusCode))
      res.once('error', reject)
    })
    req.once('error', reject)
    req.setTimeout(5_000, () => req.destroy(new Error('benchmark request timeout')))
  })
}

async function waitFor(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await request(port)) === 200) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20))
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
  const proxyPort = await freePort()
  const server = new Server({
    listeners: [`127.0.0.1:${proxyPort}`],
    routes: [{ path: '/', upstreams: [`127.0.0.1:${origin.address().port}`] }],
    gracePeriodMs: 0,
    shutdownTimeoutMs: 500,
    logLevel: 'off',
  })

  try {
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
    await server.stop()
    origin.closeAllConnections?.()
    await new Promise((resolve) => origin.close(resolve))
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
