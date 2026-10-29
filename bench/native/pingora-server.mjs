import { lookup } from 'node:dns/promises'

import { Server } from './index.js'

const port = Number(process.env.PORT ?? 8085)
const originHost = process.env.ORIGIN_HOST ?? 'origin'
const originPort = process.env.ORIGIN_PORT ?? '8080'
const threads = Number(process.env.THREADS ?? 4)

const { address } = await lookup(originHost)
const upstream = `${address.includes(':') ? `[${address}]` : address}:${originPort}`

const server = new Server({
  listeners: [`0.0.0.0:${port}`],
  routes: [{ path: '/', upstreams: [upstream] }],
  threads,
  logLevel: 'off',
})
server.start()

const keepAlive = setInterval(() => {}, 1 << 30)
process.once('SIGTERM', async () => {
  clearInterval(keepAlive)
  await server.stop()
  process.exit(0)
})
