import fs from 'node:fs'
import path from 'node:path'

const npmDir = path.resolve('npm')
const packageJsonPath = path.resolve('package.json')
const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))

const dirs = fs
  .readdirSync(npmDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

if (dirs.length === 0) {
  throw new Error(`No platform packages found in ${npmDir}`)
}

const optionalDependencies = {}
for (const dir of dirs) {
  const platform = JSON.parse(
    fs.readFileSync(path.join(npmDir, dir, 'package.json'), 'utf8'),
  )
  if (!platform.name?.startsWith('@pingora/binding-')) {
    throw new Error(`Unexpected platform package name: ${platform.name}`)
  }
  if (platform.version !== pkg.version) {
    throw new Error(
      `${platform.name}@${platform.version} does not match ${pkg.name}@${pkg.version}`,
    )
  }
  optionalDependencies[platform.name] = platform.version
}

const expected = pkg.napi?.targets?.length
if (expected && Object.keys(optionalDependencies).length !== expected) {
  throw new Error(
    `Expected ${expected} platform packages, found ${Object.keys(optionalDependencies).length}`,
  )
}

pkg.optionalDependencies = Object.fromEntries(
  Object.entries(optionalDependencies).sort(([a], [b]) => a.localeCompare(b)),
)
fs.writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`)
console.log(`Added ${Object.keys(optionalDependencies).length} platform dependencies to package.json`)
