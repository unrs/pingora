const http = require('http')
const net = require('net')

const { Server } = require('../index.js')

function listen(server) {
  return new Promise(function (resolve, reject) {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', function () {
      resolve(server.address().port)
    })
  })
}

function close(server) {
  return new Promise(function (resolve) {
    server.close(resolve)
  })
}

function request(port) {
  return new Promise(function (resolve, reject) {
    const req = http.get({ host: '127.0.0.1', port: port, path: '/' }, function (res) {
      res.resume()
      res.once('end', function () {
        if (res.statusCode !== 200) reject(new Error('unexpected status ' + res.statusCode))
        else resolve()
      })
    })
    req.once('error', reject)
    req.setTimeout(1000, function () {
      req.destroy(new Error('request timed out'))
    })
  })
}

async function main() {
  const origin = http.createServer(function (_req, res) {
    res.end('ok')
  })
  const originPort = await listen(origin)
  const probe = net.createServer()
  const proxyPort = await listen(probe)
  await close(probe)

  const server = new Server({
    listeners: ['127.0.0.1:' + proxyPort],
    routes: [{ path: '/', upstreams: ['127.0.0.1:' + originPort] }],
    gracePeriodMs: 0,
    shutdownTimeoutMs: 500,
    logLevel: 'off',
  })

  try {
    server.start()
    const deadline = Date.now() + 10_000
    for (;;) {
      try {
        await request(proxyPort)
        break
      } catch (error) {
        if (Date.now() > deadline) throw error
        await new Promise(function (resolve) {
          setTimeout(resolve, 100)
        })
      }
    }
  } finally {
    await server.stop()
    await close(origin)
  }
}

main().catch(function (error) {
  console.error(error)
  process.exitCode = 1
})
