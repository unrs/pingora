// Benchmark tooling runs directly on Node 24 (type stripping); it is not part of the runtime package.
import { spawnSync } from 'node:child_process'
import http from 'node:http'
import { availableParallelism, cpus, totalmem } from 'node:os'
import { readFileSync, writeFileSync } from 'node:fs'
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

function readOptional(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function hostMetadata() {
  const cpu = readOptional('/proc/cpuinfo')
    ?.split('\n')
    .find((line) => line.startsWith('model name'))
    ?.split(':')[1]
    ?.trim()
  const kernel = readOptional('/proc/sys/kernel/osrelease')?.trim() ?? null
  return {
    platform: `${process.platform}-${process.arch}`,
    cpu: cpu ?? null,
    cores: cpus().length,
    runnerParallelism: availableParallelism(),
    memoryMiB: Math.round(totalmem() / 1048576),
    kernel,
    node: process.version,
  }
}

const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency })
const targets: Array<[string, number, string]> = [
  ['nginx', 18081, 'http://nginx:80'],
  ['caddy', 18082, 'http://caddy:80'],
  ['openresty', 18083, 'http://openresty:80'],
  ['haproxy', 18084, 'http://haproxy:80'],
  ['pingora', 18085, 'http://pingora:8085'],
  ['raw-pingora', 18087, 'http://raw-pingora:8085'],
  ['pingap', 18088, 'http://pingap:80'],
]
const serviceByTarget: Record<string, string> = {
  'direct origin': 'origin',
  nginx: 'nginx',
  caddy: 'caddy',
  openresty: 'openresty',
  haproxy: 'haproxy',
  pingora: 'pingora',
  'raw-pingora': 'raw-pingora',
  pingap: 'pingap',
}
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

function dockerOutput(...args: string[]): string {
  const result = spawnSync('docker', args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`docker ${args.join(' ')} failed`)
  return result.stdout.trim()
}

function cgroupPath(service: string): string | null {
  try {
    const id = dockerOutput('compose', '-f', compose, 'ps', '-q', service)
    if (!id) return null
    const state = dockerOutput('inspect', '-f', '{{.State.Running}} {{.State.Pid}}', id).split(' ')
    if (state[0] !== 'true' || !state[1] || state[1] === '0') return null
    const line = readFileSync(`/proc/${state[1]}/cgroup`, 'utf8')
      .split('\n')
      .find((entry) => entry.startsWith('0::'))
    if (!line || !line.includes(id)) return null
    return `/sys/fs/cgroup${line.slice(3)}`
  } catch {
    return null
  }
}

function cgroupUsage(
  path: string | null,
): { cpuUsec?: number; memoryMiB?: number } | null {
  if (!path) return null
  const usage: { cpuUsec?: number; memoryMiB?: number } = {}
  try {
    const cpu = readFileSync(`${path}/cpu.stat`, 'utf8').match(/usage_usec (\d+)/)
    if (cpu) usage.cpuUsec = Number(cpu[1])
  } catch {}
  try {
    usage.memoryMiB = Number(readFileSync(`${path}/memory.current`, 'utf8')) / 1048576
  } catch {}
  return usage.cpuUsec === undefined && usage.memoryMiB === undefined ? null : usage
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

function runLoadgen(url: string): { requests: number; rps: number; p50Ms: number; p99Ms: number } {
  const output = dockerOutput(
    'compose',
    '-f',
    compose,
    'run',
    '--rm',
    '--no-deps',
    'loadgen',
    '-url',
    url,
    '-duration',
    `${durationMs}ms`,
    '-concurrency',
    String(concurrency),
  )
  return JSON.parse(output) as { requests: number; rps: number; p50Ms: number; p99Ms: number }
}

async function measure(url: string, port: number, label: string, mode: string) {
  await waitFor(port)
  const path = cgroupPath(serviceByTarget[label.replace(/ \(start\)| \(end\)/, '')])
  const before = cgroupUsage(path)
  const started = Date.now()
  const result = runLoadgen(url)
  const elapsedMs = Date.now() - started
  const after = cgroupUsage(path)
  const cpuPercent =
    before?.cpuUsec !== undefined && after?.cpuUsec !== undefined
      ? Math.max(0, ((after.cpuUsec - before.cpuUsec) / 1000 / elapsedMs) * 100)
      : null
  return {
    mode,
    target: label,
    requests: result.requests,
    rps: result.rps,
    p50Ms: result.p50Ms,
    p99Ms: result.p99Ms,
    cpuPercent,
    memoryMiB: after?.memoryMiB ?? null,
  }
}

async function runMode(mode: string) {
  process.env.ORIGIN_READ_PER_REQUEST = mode === 'file' ? '1' : '0'
  docker('compose', '-f', compose, 'down')
  docker('compose', '-f', compose, 'build', 'loadgen')
  docker('compose', '-f', compose, 'up', '-d', '--build')
  await waitFor(18080)

  const results = [await measure('http://origin:8080', 18080, 'direct origin (start)', mode)]
  for (const [label, port, url] of targets) results.push(await measure(url, port, label, mode))
  results.push(await measure('http://origin:8080', 18080, 'direct origin (end)', mode))
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

  const result = { startedAt, commit, durationMs, concurrency, threads, modes, host: hostMetadata(), results }
  const serialized = JSON.stringify(result, null, 2)
  console.log(serialized)
  if (process.env.BENCH_NATIVE_OUTPUT) writeFileSync(process.env.BENCH_NATIVE_OUTPUT, serialized + '\n')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
