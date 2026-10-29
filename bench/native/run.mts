// Benchmark tooling runs directly on Node 24 (type stripping); it is not part of the runtime package.
import { spawnSync } from 'node:child_process'
import http from 'node:http'
import { availableParallelism } from 'node:os'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const report = process.report?.getReport?.() as
  | { header?: { glibcVersionRuntime?: string } }
  | undefined
const isGlibc = Boolean(report?.header?.glibcVersionRuntime)
if (process.platform !== 'linux' || process.arch !== 'x64' || !isGlibc) {
  throw new Error('bench:native requires Linux x64 with glibc for the prebuilt Docker binding')
}

const startedAt = new Date().toISOString()
const commit: string | null = process.env.GITHUB_SHA || null
const compose = join(dirname(fileURLToPath(import.meta.url)), 'docker-compose.yml')
const inCI = process.env.GITHUB_ACTIONS === 'true'
const durationMs = Number(process.env.BENCH_NATIVE_DURATION_MS ?? 2_000)
const concurrency = positiveInteger('BENCH_NATIVE_CONCURRENCY', process.env.BENCH_NATIVE_CONCURRENCY ?? 16)
const threads = positiveInteger(
  'BENCH_NATIVE_THREADS',
  process.env.BENCH_NATIVE_THREADS ?? Math.min(4, availableParallelism()),
)
if (!Number.isFinite(durationMs) || durationMs <= 0) {
  throw new Error(`BENCH_NATIVE_DURATION_MS must be a finite positive number, got ${process.env.BENCH_NATIVE_DURATION_MS}`)
}
process.env.BENCH_NATIVE_THREADS = String(threads)

const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency })
const targets: Array<[string, number]> = [
  ['nginx', 18081],
  ['caddy', 18082],
  ['openresty', 18083],
  ['haproxy', 18084],
  ['pingora', 18085],
  ['raw-pingora', 18087],
  ['pingap', 18088],
]
const modes = (process.env.BENCH_NATIVE_ORIGIN_MODES ?? 'cached,file')
  .split(',')
  .map((mode) => mode.trim())
for (const mode of modes) {
  if (mode !== 'cached' && mode !== 'file') {
    throw new Error(`unsupported origin mode: ${mode}`)
  }
}

function positiveInteger(name: string, value: unknown): number {
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${name} must be a positive integer, got ${value}`)
  }
  return number
}

function docker(...args: string[]): void {
  const result = spawnSync('docker', args, { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`docker ${args.join(' ')} failed`)
}

function request(port: number, timeoutMs = 5_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint()
    const req = http.get({ host: '127.0.0.1', port, path: '/', agent }, (res) => {
      res.resume()
      res.once('error', reject)
      res.once('end', () => {
        if (res.statusCode !== 200) reject(new Error(`unexpected status ${res.statusCode}`))
        else resolve(Number(process.hrtime.bigint() - started) / 1e6)
      })
    })
    req.once('error', reject)
    req.setTimeout(timeoutMs, () => req.destroy(new Error('request timeout')))
  })
}

async function waitFor(port: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await request(port, 500)) >= 0) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`target ${port} did not become ready`)
}

async function measure(port: number, label: string, mode: string) {
  await waitFor(port)
  const latencies: number[] = []
  const started = Date.now()
  const deadline = started + durationMs
  const workers = Array.from({ length: concurrency }, async () => {
    while (Date.now() < deadline) {
      latencies.push(await request(port))
    }
  })
  await Promise.all(workers)
  const elapsedMs = Date.now() - started
  latencies.sort((a, b) => a - b)
  const percentile = (p: number) =>
    latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * p) - 1)]
  return {
    mode,
    target: label,
    requests: latencies.length,
    rps: Math.round((latencies.length / elapsedMs) * 1_000),
    p50Ms: percentile(0.5),
    p99Ms: percentile(0.99),
  }
}

async function runMode(mode: string) {
  process.env.ORIGIN_READ_PER_REQUEST = mode === 'file' ? '1' : '0'
  docker('compose', '-f', compose, 'down')
  docker('compose', '-f', compose, 'up', '-d', '--build')
  await waitFor(18080)

  const results = [await measure(18080, 'direct origin (start)', mode)]
  for (const [label, port] of targets) results.push(await measure(port, label, mode))
  results.push(await measure(18080, 'direct origin (end)', mode))
  return results
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
    if (!inCI) {
      try {
        docker('compose', '-f', compose, 'down')
      } catch {}
    }
  }

  const result = { startedAt, commit, durationMs, concurrency, threads, modes, results }
  const serialized = JSON.stringify(result, null, 2)
  console.log(serialized)
  if (process.env.BENCH_NATIVE_OUTPUT) writeFileSync(process.env.BENCH_NATIVE_OUTPUT, serialized + '\n')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
