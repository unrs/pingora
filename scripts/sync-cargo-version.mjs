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

// Keep the crate version in sync with the npm package. The platform package
// versions are generated at publish time from this version.
const cargoPath = path.join(rootDir, 'Cargo.toml')
const cargo = fs.readFileSync(cargoPath, 'utf8')
const versionLine = /^version = "[^"]+"/m

if (!versionLine.test(cargo)) {
  throw new Error('Could not find the [package] version in Cargo.toml')
}

fs.writeFileSync(cargoPath, cargo.replace(versionLine, `version = "${version}"`))
console.log(`Synced Cargo.toml to ${version}`)
