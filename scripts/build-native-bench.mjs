import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync } from 'node:fs'

if (process.platform !== 'linux' || process.arch !== 'x64') {
  throw new Error('bench:native requires Linux x64 to build the Docker binding')
}

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const binding = 'pingora.linux-x64-gnu.node'
const full = 'bench/native/pingora-full.node'
const minimal = 'bench/native/pingora-minimal.node'

function buildFull() {
  execFileSync(pnpm, ['run', 'build'], { stdio: 'inherit' })
  if (!existsSync(binding)) throw new Error(`missing ${binding} after full build`)
  copyFileSync(binding, full)
}

function buildMinimal() {
  execFileSync(pnpm, ['run', 'build:bench-minimal'], { stdio: 'inherit' })
  if (!existsSync(binding)) throw new Error(`missing ${binding} after minimal build`)
  copyFileSync(binding, minimal)
}

function restoreFull() {
  if (!existsSync(full)) return
  copyFileSync(full, binding)
  execFileSync(process.execPath, ['scripts/postbuild.mjs'], { stdio: 'inherit' })
}

buildFull()
try {
  buildMinimal()
} finally {
  restoreFull()
}
