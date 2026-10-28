import { Server } from './index.js'

const port = Number(process.env.PORT ?? 8085)
const origin = process.env.ORIGIN ?? 'origin:8080'
const threads = Number(process.env.THREADS ?? 4)

const server = new Server({
  listeners: [`0.0.0.0:${port}`],
  routes: [{ path: '/', upstreams: [origin] }],
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
