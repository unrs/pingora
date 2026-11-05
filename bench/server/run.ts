// Benchmark tooling runs directly on Node 24 (type stripping); it is not part of the runtime package.
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { availableParallelism, cpus, totalmem } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const compose = join(dirname(fileURLToPath(import.meta.url)), 'docker-compose.yml')
const dockerBin = process.env.BENCH_SERVER_DOCKER ?? 'docker'
const durationMs = Number(process.env.BENCH_SERVER_DURATION_MS ?? 2_000)
const warmupMs = Number(process.env.BENCH_SERVER_WARMUP_MS ?? 500)
const concurrency = positiveInteger(
  'BENCH_SERVER_CONCURRENCY',
  process.env.BENCH_SERVER_CONCURRENCY ?? 16,
)
const cpusLimit = process.env.BENCH_SERVER_CPUS ?? '1'
const memoryLimit = process.env.BENCH_SERVER_MEMORY ?? '512m'
if (!Number.isFinite(durationMs) || durationMs <= 0) {
  throw new Error(
    `BENCH_SERVER_DURATION_MS must be a finite positive number, got ${process.env.BENCH_SERVER_DURATION_MS}`,
  )
}
if (!Number.isFinite(warmupMs) || warmupMs < 0) {
  throw new Error(
    `BENCH_SERVER_WARMUP_MS must be a finite non-negative number, got ${process.env.BENCH_SERVER_WARMUP_MS}`,
  )
}

type WorkloadName = 'plaintext' | 'json' | 'path-param'
type Mode = 'native' | 'js' | 'proxy-js' | 'in-process'
type Target = {
  name: string
  service: string
  port: number
  modes?: Partial<Record<WorkloadName, Exclude<Mode, 'in-process'>>>
}
type Workload = { name: WorkloadName; path: string }
type LoadgenResult = {
  requests: number
  errors: number
  elapsedMs: number
  rps: number
  p50Ms: number
  p95Ms: number
  p99Ms: number
}

const targets: Target[] = [
  { name: 'node:http', service: 'node', port: 18100 },
  { name: 'express', service: 'express', port: 18101 },
  { name: 'fastify', service: 'fastify', port: 18102 },
  { name: 'koa', service: 'koa', port: 18103 },
  { name: 'nestjs', service: 'nestjs', port: 18104 },
  { name: 'hono', service: 'hono', port: 18105 },
  { name: 'elysia', service: 'elysia', port: 18106 },
  {
    name: 'hybrid (poc)',
    service: 'hybrid',
    port: 18108,
    modes: { plaintext: 'native', json: 'native', 'path-param': 'proxy-js' },
  },
  {
    name: '@pingora/http-server',
    service: 'http-server',
    port: 18107,
    modes: { plaintext: 'native', json: 'native', 'path-param': 'js' },
  },
]
const workloads: Workload[] = [
  { name: 'plaintext', path: '/plaintext' },
  { name: 'json', path: '/json' },
  { name: 'path-param', path: '/users/42' },
]

function positiveInteger(name: string, value: unknown): number {
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${name} must be a positive integer, got ${value}`)
  }
  return number
}

function docker(...args: string[]): void {
  const result = spawnSync(dockerBin, args, { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`${dockerBin} ${args.join(' ')} failed`)
}

function dockerOutput(...args: string[]): string {
  const result = spawnSync(dockerBin, args, { encoding: 'utf8' })
  if (result.status !== 0) {
    const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n')
    throw new Error(`${dockerBin} ${args.join(' ')} failed: ${detail}`)
  }
  return result.stdout.trim()
}

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

function runtimeImage(): string {
  const dockerfile = readFileSync(new URL('./Dockerfile', import.meta.url), 'utf8')
  const match = /^FROM\s+(\S+)/m.exec(dockerfile)
  return match?.[1] ?? 'unknown'
}

// Both manifests use exact pins; a range on either side would report a false mismatch.
function assertVersionParity(): void {
  const root = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { devDependencies?: Record<string, string> }
  const bench = JSON.parse(
    readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
  ) as { dependencies?: Record<string, string> }
  for (const [name, version] of Object.entries(bench.dependencies ?? {})) {
    const rootVersion = root.devDependencies?.[name]
    if (rootVersion !== undefined && rootVersion !== version) {
      throw new Error(`bench/server ${name} ${version} does not match root devDependency ${rootVersion}`)
    }
  }
}

function frameworkVersions(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
    dependencies?: Record<string, string>
  }
  return pkg.dependencies ?? {}
}

function request(port: number, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/plaintext' }, (res) => {
      res.resume()
      res.once('error', reject)
      res.once('end', () => {
        if (res.statusCode === 200) resolve()
        else reject(new Error(`unexpected status ${res.statusCode}`))
      })
    })
    req.once('error', reject)
    req.setTimeout(timeoutMs, () => req.destroy(new Error('request timeout')))
  })
}

async function waitFor(port: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await request(port, 500)
      return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`target ${port} did not become ready`)
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

function cgroupUsage(path: string | null): { cpuUsec?: number; memoryMiB?: number } | null {
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

function runLoadgen(url: string, milliseconds = durationMs): LoadgenResult {
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
    `${milliseconds}ms`,
    '-concurrency',
    String(concurrency),
  )
  return JSON.parse(output) as LoadgenResult
}

function processRss(service: string): number | null {
  try {
    const id = dockerOutput('compose', '-f', compose, 'ps', '-q', service)
    if (!id) return null
    const script =
      'for p in /proc/[0-9]*; do ' +
      'cmd=$(tr "\\0" "\\n" < "$p/cmdline" 2>/dev/null | head -n 1) || continue; ' +
      'case "${cmd##*/}" in node) ;; *) continue ;; esac; ' +
      'sed -n "s/^VmRSS:[[:space:]]*\\([0-9]*\\).*/\\1/p" "$p/status"; ' +
      'done'
    const values = dockerOutput('exec', id, 'sh', '-c', script)
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map(Number)
      .filter((value) => Number.isFinite(value))
    return values.length === 0 ? null : values.reduce((total, value) => total + value, 0) / 1024
  } catch {
    return null
  }
}

async function measure(service: string, workload: Workload, order: number, mode: Mode) {
  const path = cgroupPath(service)
  const before = cgroupUsage(path)
  const result = runLoadgen(`http://${service}:8080${workload.path}`)
  const after = cgroupUsage(path)
  const cpuPercent =
    before?.cpuUsec !== undefined && after?.cpuUsec !== undefined
      ? Math.max(0, ((after.cpuUsec - before.cpuUsec) / 1000 / result.elapsedMs) * 100)
      : null
  return {
    workload: workload.name,
    mode,
    order,
    requests: result.requests,
    errors: result.errors,
    rps: result.rps,
    p50Ms: result.p50Ms,
    p95Ms: result.p95Ms,
    p99Ms: result.p99Ms,
    cpuPercent,
    memoryMiB: after?.memoryMiB ?? null,
    rssMiB: processRss(service),
  }
}

type Measurement = Awaited<ReturnType<typeof measure>>
type TargetResult = { target: string; service: string; measurements: Measurement[] }

async function main() {
  assertVersionParity()
  docker('compose', '-f', compose, 'down')
  const results: TargetResult[] = targets.map((target) => ({
    target: target.name,
    service: target.service,
    measurements: [],
  }))
  const byService = new Map(results.map((result) => [result.service, result]))
  try {
    docker('compose', '-f', compose, 'build', 'http-server', 'loadgen')
    docker('compose', '-f', compose, 'up', '-d', '--no-build')

    for (const target of targets) {
      await waitFor(target.port)
      if (warmupMs > 0) {
        runLoadgen(`http://${target.service}:8080/plaintext`, warmupMs)
      }
    }

    for (const [workloadIndex, workload] of workloads.entries()) {
      const order = targets.map(
        (_, index) => targets[(index + workloadIndex) % targets.length],
      )
      for (const [position, target] of order.entries()) {
        const mode: Mode = target.modes?.[workload.name] ?? 'in-process'
        const measurement = await measure(target.service, workload, position, mode)
        byService.get(target.service)?.measurements.push(measurement)
      }
    }
  } catch (error) {
    try {
      docker('compose', '-f', compose, 'logs', '--no-color')
    } catch {}
    throw error
  } finally {
    if (process.env.BENCH_SERVER_KEEP !== '1') {
      try {
        docker('compose', '-f', compose, 'down')
      } catch {}
    }
  }

  const result = {
    startedAt: new Date().toISOString(),
    commit: process.env.GITHUB_SHA || null,
    durationMs,
    warmupMs,
    concurrency,
    limits: { cpus: cpusLimit, memory: memoryLimit },
    host: hostMetadata(),
    versions: frameworkVersions(),
    runtime: { image: runtimeImage(), type: 'docker' },
    results,
  }
  const serialized = JSON.stringify(result, null, 2)
  console.log(serialized)
  if (process.env.BENCH_SERVER_OUTPUT) {
    writeFileSync(process.env.BENCH_SERVER_OUTPUT, `${serialized}\n`)
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
