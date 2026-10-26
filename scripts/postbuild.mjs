import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { patch } = require('napi-postinstall/patch')

const entry = 'index.js'
const marker = '/* pingora async access-log wrapper */'

patch({ entry, name: 'pingora' })

let code = readFileSync(entry, 'utf8')
if (!code.includes(marker)) {
  code += `
${marker}
{
  const serverPrototype = module.exports.Server.prototype
  const nativeSetAccessLogHandler = serverPrototype.setAccessLogHandler
  serverPrototype.setAccessLogHandler = function setAccessLogHandler(handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('access log handler must be a function')
    }
    return nativeSetAccessLogHandler.call(this, (record) => {
      try {
        const result = handler(record)
        if (result && typeof result.then === 'function') {
          Promise.resolve(result).catch(() => {})
        }
      } catch {}
    })
  }
}
`
  writeFileSync(entry, code)
}
