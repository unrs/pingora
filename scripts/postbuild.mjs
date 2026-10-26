import { patch } from 'napi-postinstall/patch'

patch({
  entry: 'index.js',
  name: 'pingora',
  append: `
/* pingora async access-log wrapper */
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
`,
})
