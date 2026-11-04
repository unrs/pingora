import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { test } from 'vitest'

test('generated loader keeps the napi-postinstall fallback', async () => {
  const loader = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(loader, /require\('napi-postinstall\/fallback'\)/)
  assert.match(loader, /SKIP_PINGORA_FALLBACK/)
})
