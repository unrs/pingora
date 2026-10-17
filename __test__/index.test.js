import assert from 'node:assert/strict'
import { test } from 'node:test'

import { __napiBindingTarget, version } from '../index.js'
import pkg from '../package.json' with { type: 'json' }

test('loads the native binding', () => {
  assert.equal(__napiBindingTarget, 'native')
})

test('exposes the package version', () => {
  assert.equal(version(), pkg.version)
})
