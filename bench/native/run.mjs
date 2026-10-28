import { spawnSync } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import { availableParallelism } from 'node:os'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Server } from '../../index.js'

const here = dirname(fileURLToPath(import.meta.url))
const compose = join(here, 'docker-compose.yml')
const durationMs = Number(process.env.BENCH_NATIVE_DURATION_MS ?? 2_000)
if (!Number.isFinite(durationMs) || durationMs <= 0) {
  throw new Error(`BENCH_NATIVE_DURATION_MS must be a finite positive number, got ${process.env.BENCH_NATIVE_DURATION_MS}`)
}
const concurrency = positiveInteger('BENCH_NATIVE_CONCURRENCY', process.env.BENCH_NATIVE_CONCURRENCY ?? 16)
const threads = positiveInteger(
  'BENCH_NATIVE_THREADS',
  process.env.BENCH_NATIVE_THREADS ?? Math.min(4, availableParallelism()),
)
const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency })
const targets = [
  ['nginx', 18081],
  ['caddy', 18082],
  ['openresty', 18083],
  ['haproxy', 18084],
]

function positiveInteger(name, value) {
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${name} must be a positive integer, got ${value}`)
  }
  return number
}

function docker(...args) {
  const result = spawnSync('docker', args, { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`docker ${args.join(' ')} failed`)
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

function request(port) {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint()
    const req = http.get({ host: '127.0.0.1', port, path: '/', agent }, (res) => {
      res.resume()
      res.once('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`unexpected status ${res.statusCode}`))
          return
        }
        resolve(Number(process.hrtime.bigint() - started) / 1e6)
      })
      res.once('error', reject)
    })
    req.once('error', reject)
    req.setTimeout(10_000, () => req.destroy(new Error('request timeout')))
  })
}

async function waitFor(port) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      if ((await request(port)) >= 0) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`target ${port} did not become ready`)
}

async function measure(port, label) {
  await waitFor(port)
  const latencies = []
  const startedAt = Date.now()
  const deadline = startedAt + durationMs
  const workers = Array.from({ length: concurrency }, async () => {
    while (Date.now() < deadline) {
      latencies.push(await request(port))
    }
  })
  await Promise.all(workers)
  const elapsedMs = Date.now() - startedAt
  latencies.sort((a, b) => a - b)
  const percentile = (p) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))]
  return {
    target: label,
    requests: latencies.length,
    rps: Math.round((latencies.length / elapsedMs) * 1_000),
    p50Ms: percentile(0.5),
    p99Ms: percentile(0.99),
  }
}

async function main() {
  docker('compose', '-f', compose, 'up', '-d')
  const origin = 18080
  let server
  try {
    const proxyPort = await freePort()
    server = new Server({
      listeners: [`127.0.0.1:${proxyPort}`],
      routes: [{ path: '/', upstreams: [`127.0.0.1:${origin}`] }],
      threads,
      gracePeriodMs: 0,
      shutdownTimeoutMs: 500,
      logLevel: 'off',
    })
    await waitFor(origin)
    server.start()
    await waitFor(proxyPort)
    const results = [await measure(origin, 'direct origin (start)')]
    for (const [label, port] of targets) results.push(await measure(port, label))
    results.push(await measure(proxyPort, 'pingora'))
    results.push(await measure(origin, 'direct origin (end)'))
    const result = { durationMs, concurrency, threads, results }
    const serialized = JSON.stringify(result, null, 2)
    console.log(serialized)
    if (process.env.BENCH_NATIVE_OUTPUT) {
      writeFileSync(process.env.BENCH_NATIVE_OUTPUT, serialized + '\n')
    }
  } finally {
    agent.destroy()
    await server?.stop()
    docker('compose', '-f', compose, 'down')
  }
}

main().catch((error) => {
  console.error(error)
  try {
    docker('compose', '-f', compose, 'down')
  } catch {}
  process.exitCode = 1
})
