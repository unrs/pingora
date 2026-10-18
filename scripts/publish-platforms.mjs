import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const dryRun = process.env.DRY_RUN === '1'
const root = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const npmDir = path.resolve('npm')
const dirs = fs
  .readdirSync(npmDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

if (dirs.length === 0) {
  throw new Error(`No platform packages found in ${npmDir}`)
}

for (const dir of dirs) {
  const packageDir = path.join(npmDir, dir)
  const { name, version } = JSON.parse(
    fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'),
  )

  if (version !== root.version) {
    throw new Error(`${name}@${version} does not match ${root.name}@${root.version}`)
  }

  const readmePath = path.join(packageDir, 'README.md')
  if (fs.existsSync(readmePath)) {
    const readme = fs
      .readFileSync(readmePath, 'utf8')
      .replace(
        '`@pingora/binding`',
        '[`pingora`](https://www.npmjs.com/package/pingora). Install `pingora` instead of this package.',
      )
    fs.writeFileSync(readmePath, readme)
  }

  console.log(`\nPublishing ${name}@${version} from ${path.relative(process.cwd(), packageDir)}`)

  const result = spawnSync(
    'pnpm',
    [
      '--dir',
      packageDir,
      'publish',
      '--access',
      'public',
      '--provenance',
      '--no-git-checks',
      '--ignore-scripts',
      ...(dryRun ? ['--dry-run'] : []),
    ],
    { encoding: 'utf8', env: process.env, stdio: 'pipe' },
  )

  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)

  if (result.status === 0) continue

  const output = `${result.stdout}\n${result.stderr}`
  if (/previously published|EPUBLISHCONFLICT|E409/i.test(output)) {
    console.log(`Skipping ${name}@${version}: version already exists`)
    continue
  }

  process.exit(result.status ?? 1)
}
