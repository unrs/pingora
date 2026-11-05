import { rmSync } from 'node:fs'
import http from 'node:http'

import { Server } from 'pingora'

const port = Number(process.env.PORT ?? 8080)
const socket = process.env.INTERNAL_SOCKET ?? '/tmp/pingora-hybrid.sock'
const JSON_HEADERS = { 'content-type': 'application/json' }

const internal = http.createServer((request, response) => {
  const path = request.url ?? '/'
  const user = /^\/users\/([^/]+)$/.exec(path)
  if (user) {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ id: user[1] }))
    return
  }
  response.statusCode = 404
  response.end('Not Found')
})

await new Promise<void>((resolve, reject) => {
  rmSync(socket, { force: true })
  internal.once('error', reject)
  internal.listen(socket, () => resolve())
})

const server = new Server({
  listeners: [`0.0.0.0:${port}`],
  routes: [
    {
      path: '/plaintext',
      respond: { headers: { 'content-type': 'text/plain' }, body: 'Hello, World!' },
    },
    {
      path: '/json',
      respond: { headers: JSON_HEADERS, body: JSON.stringify({ message: 'Hello, World!' }) },
    },
    { pathPrefix: '/', upstreams: [`unix:${socket}`] },
  ],
  threads: 1,
  gracePeriodMs: 0,
  shutdownTimeoutMs: 1_000,
  logLevel: 'off',
})

server.start()
process.once('SIGTERM', () => {
  void server.stop().then(() => {
    internal.close(() => {
      rmSync(socket, { force: true })
      process.exit(0)
    })
  })
})
