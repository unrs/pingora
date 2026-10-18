import { Server } from 'pingora'

const server = new Server({
  listeners: ['127.0.0.1:8080'],
  routes: [
    {
      id: 'app',
      pathPrefix: '/',
      upstreams: ['127.0.0.1:3000'],
    },
  ],
  handlerTimeoutMs: 1_000,
})

server.setRequestHandler(async (request) => {
  if (request.path === '/health') {
    return { action: 'respond', status: 200, body: 'ok' }
  }

  if (request.headers.authorization !== 'Bearer secret') {
    return { action: 'respond', status: 401, body: 'unauthorized' }
  }

  if (request.path.startsWith('/canary')) {
    return { action: 'upstream', upstream: '127.0.0.1:3001' }
  }

  return {
    action: 'continue',
    requestHeaders: { 'x-handler': 'request-handler-example' },
  }
})

server.start()
console.log(server.status())
