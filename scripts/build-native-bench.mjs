import { execFileSync } from 'node:child_process'
import { copyFileSync } from 'node:fs'

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const binding = 'pingora.linux-x64-gnu.node'

execFileSync(pnpm, ['run', 'build'], { stdio: 'inherit' })
copyFileSync(binding, 'bench/native/pingora-full.node')

execFileSync(pnpm, ['run', 'build:bench-minimal'], { stdio: 'inherit' })
copyFileSync(binding, 'bench/native/pingora-minimal.node')

execFileSync(process.execPath, ['scripts/postbuild.mjs'], { stdio: 'inherit' })
