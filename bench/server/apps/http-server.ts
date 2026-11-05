import { createServer } from '../../../packages/http-server/lib/index.mjs'

const port = Number(process.env.PORT ?? 8080)
const JSON_HEADERS = { 'content-type': 'application/json' }

const app = createServer({
  listen: `0.0.0.0:${port}`,
  server: { threads: 1, logLevel: 'off', gracePeriodMs: 0, shutdownTimeoutMs: 1_000 },
  handler: ({ path }) => {
    if (path === '/plaintext') {
      return { action: 'respond', headers: { 'content-type': 'text/plain' }, body: 'Hello, World!' }
    }
    if (path === '/json') {
      return {
        action: 'respond',
        headers: JSON_HEADERS,
        body: JSON.stringify({ message: 'Hello, World!' }),
      }
    }
    const user = /^\/users\/([^/]+)$/.exec(path)
    if (user) {
      return {
        action: 'respond',
        headers: JSON_HEADERS,
        body: JSON.stringify({ id: user[1] }),
      }
    }
    return { action: 'respond', status: 404, body: 'Not Found' }
  },
})

await app.start()
process.once('SIGTERM', () => {
  void app.close().then(() => process.exit(0))
})
