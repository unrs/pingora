import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'vitest'

import { __napiBindingTarget, version } from '../index.js'

const require = createRequire(import.meta.url)
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('loads through require', () => {
  const cjs = require('../index.js')
  assert.equal(cjs.__napiBindingTarget, 'native')
  assert.equal(cjs.version(), pkg.version)
})

test('loads through import', () => {
  assert.equal(__napiBindingTarget, 'native')
  assert.equal(version(), pkg.version)
})
