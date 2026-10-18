import { spawnSync } from 'node:child_process'
import fs from 'node:fs'

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const url = `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${pkg.version}`

const response = await fetch(url)
if (response.status === 200) {
  console.log(`${pkg.name}@${pkg.version} is already published; skipping`)
  process.exit(0)
}
if (response.status !== 404) {
  throw new Error(
    `npm registry answered ${response.status} for ${pkg.name}@${pkg.version}`,
  )
}

const result = spawnSync(
  'pnpm',
  [
    'publish',
    '--access',
    'public',
    '--provenance',
    '--no-git-checks',
    '--ignore-scripts',
  ],
  { stdio: 'inherit', env: process.env },
)
process.exit(result.status ?? 1)
