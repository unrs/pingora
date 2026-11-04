import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

import { test } from 'vitest'

const require = createRequire(import.meta.url)

test('exposes a CommonJS entry', () => {
  const cjs = require('@pingora/http-server')
  assert.equal(typeof cjs.createServer, 'function')
})
