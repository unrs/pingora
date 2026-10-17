import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = fileURLToPath(new URL('..', import.meta.url))
const packageJsonPath = path.join(rootDir, 'package.json')
const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
const version = pkg.version

if (!version) {
  throw new Error('package.json has no version')
}

// Keep every platform package on the root version.
for (const entry of fs.readdirSync(path.join(rootDir, 'npm'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const platformPackagePath = path.join(rootDir, 'npm', entry.name, 'package.json')
  if (!fs.existsSync(platformPackagePath)) continue
  const platformPkg = JSON.parse(fs.readFileSync(platformPackagePath, 'utf8'))
  platformPkg.version = version
  fs.writeFileSync(platformPackagePath, `${JSON.stringify(platformPkg, null, 2)}\n`)
  if (pkg.optionalDependencies?.[platformPkg.name]) {
    pkg.optionalDependencies[platformPkg.name] = version
  }
}

fs.writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`)

// Keep the crate version in sync with the npm package.
const cargoPath = path.join(rootDir, 'Cargo.toml')
const cargo = fs.readFileSync(cargoPath, 'utf8')
const versionLine = /^version = "[^"]+"/m

if (!versionLine.test(cargo)) {
  throw new Error('Could not find the [package] version in Cargo.toml')
}

fs.writeFileSync(cargoPath, cargo.replace(versionLine, `version = "${version}"`))
console.log(`Synced platform packages, optionalDependencies, and Cargo.toml to ${version}`)
