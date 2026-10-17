import { Server } from 'pingora'

const server = new Server({
  listeners: ['127.0.0.1:8080'],
  routes: [
    {
      id: 'app',
      pathPrefix: '/',
      upstreams: ['127.0.0.1:3000'],
      requestHeaders: { 'x-proxied-by': 'pingora' },
    },
  ],
})

server.start()
console.log(server.status())

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

async function shutdown() {
  await server.stop()
  process.exit(0)
}
