import { spawnSync } from 'node:child_process'
import http from 'node:http'
import { availableParallelism } from 'node:os'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
process.env.BENCH_NATIVE_THREADS = String(threads)
const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency })
const targets = [
  ['nginx', 18081],
  ['caddy', 18082],
  ['openresty', 18083],
  ['haproxy', 18084],
  ['pingora', 18085],
  ['pingora-minimal', 18086],
]
const modes = (process.env.BENCH_NATIVE_ORIGIN_MODES ?? 'cached,file')
  .split(',')
  .map((mode) => mode.trim())
for (const mode of modes) {
  if (mode !== 'cached' && mode !== 'file') {
    throw new Error(`unsupported origin mode: ${mode}`)
  }
}

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

async function measure(port, label, mode) {
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
    mode,
    target: label,
    requests: latencies.length,
    rps: Math.round((latencies.length / elapsedMs) * 1_000),
    p50Ms: percentile(0.5),
    p99Ms: percentile(0.99),
  }
}

async function runMode(mode) {
  process.env.ORIGIN_READ_PER_REQUEST = mode === 'file' ? '1' : '0'
  docker('compose', '-f', compose, 'down')
  docker('compose', '-f', compose, 'up', '-d')

  const origin = 18080
  try {
    await waitFor(origin)
    const results = [await measure(origin, 'direct origin (start)', mode)]
    for (const [label, port] of targets) results.push(await measure(port, label, mode))
    results.push(await measure(origin, 'direct origin (end)', mode))
    return results
  } catch (error) {
    docker('compose', '-f', compose, 'logs', '--no-color', 'pingora')
    throw error
  } finally {
    docker('compose', '-f', compose, 'down')
  }
}

async function main() {
  const results = []
  try {
    for (const mode of modes) {
      console.error(`origin mode: ${mode}`)
      results.push(...(await runMode(mode)))
    }
  } finally {
    agent.destroy()
    try {
      docker('compose', '-f', compose, 'down')
    } catch {}
  }

  const result = { durationMs, concurrency, threads, modes, results }
  const serialized = JSON.stringify(result, null, 2)
  console.log(serialized)
  if (process.env.BENCH_NATIVE_OUTPUT) {
    writeFileSync(process.env.BENCH_NATIVE_OUTPUT, serialized + '\n')
  }
}

main().catch((error) => {
  console.error(error)
  try {
    docker('compose', '-f', compose, 'down')
  } catch {}
  process.exitCode = 1
})
