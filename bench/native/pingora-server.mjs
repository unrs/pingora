import { Server } from './index.js'

const port = Number(process.env.PORT ?? 8085)
const origin = process.env.ORIGIN ?? 'origin:8080'
const threads = Number(process.env.THREADS ?? 4)

new Server({
  listeners: [`0.0.0.0:${port}`],
  routes: [{ path: '/', upstreams: [origin] }],
  threads,
  logLevel: 'off',
}).start()
