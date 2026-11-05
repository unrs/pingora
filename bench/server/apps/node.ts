import http from 'node:http'

const port = Number(process.env.PORT ?? 8080)

const server = http.createServer((request, response) => {
  const path = request.url ?? '/'
  if (path === '/plaintext') {
    response.setHeader('content-type', 'text/plain')
    response.end('Hello, World!')
    return
  }
  if (path === '/json') {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ message: 'Hello, World!' }))
    return
  }
  const user = /^\/users\/([^/]+)$/.exec(path)
  if (user) {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ id: user[1] }))
    return
  }
  response.statusCode = 404
  response.end('Not Found')
})

server.listen(port, '0.0.0.0')
process.once('SIGTERM', () => server.close(() => process.exit(0)))
