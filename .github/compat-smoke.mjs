import http from 'http'
import net from 'net'

import { Server } from '../index.js'

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      resolve(server.address().port)
    })
  })
}

function close(server) {
  return new Promise((resolve) => {
    server.close(resolve)
  })
}

function request(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        body += chunk
      })
      res.once('end', () => {
        if (res.statusCode !== 200) reject(new Error(`unexpected status ${res.statusCode}`))
        else if (body !== 'ok') reject(new Error(`unexpected body ${body}`))
        else resolve()
      })
    })
    req.once('error', reject)
    req.setTimeout(1000, () => {
      req.destroy(new Error('request timed out'))
    })
  })
}

async function main() {
  const origin = http.createServer((_req, res) => {
    res.end('ok')
  })
  const originPort = await listen(origin)
  let server
  try {
    const probe = net.createServer()
    const proxyPort = await listen(probe)
    await close(probe)

    server = new Server({
      listeners: [`127.0.0.1:${proxyPort}`],
      routes: [{ path: '/', upstreams: [`127.0.0.1:${originPort}`] }],
      gracePeriodMs: 0,
      shutdownTimeoutMs: 500,
      logLevel: 'off',
    })
    server.start()
    const deadline = Date.now() + 10_000
    for (;;) {
      try {
        await request(proxyPort)
        break
      } catch (error) {
        if (Date.now() > deadline) throw error
        await new Promise((resolve) => {
          setTimeout(resolve, 100)
        })
      }
    }
  } finally {
    if (server) await server.stop()
    await close(origin)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
