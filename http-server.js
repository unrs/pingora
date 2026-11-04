'use strict'

const net = require('node:net')

const { Server } = require('./index.js')

const DEFAULT_LISTEN = '127.0.0.1:8080'
const DEFAULT_MAX_BODY = 1_048_576

function normalizeListen(listen) {
  if (typeof listen === 'number') return `127.0.0.1:${listen}`
  if (typeof listen === 'string' && listen.length > 0) return listen
  throw new TypeError('listen must be a port or address string')
}

function urlFor(listen) {
  return listen.startsWith('unix:') ? listen : `http://${listen}`
}

function createServer(options = {}) {
  if (typeof options === 'function') options = { handler: options }
  const { handler, listen = DEFAULT_LISTEN, maxRequestBodyBytes = DEFAULT_MAX_BODY, server: serverOptions = {} } = options
  if (typeof handler !== 'function') throw new TypeError('createServer requires a handler function')
  const address = normalizeListen(listen)

  const server = new Server({
    ...serverOptions,
    listeners: [address],
    routes: serverOptions.routes || [
      { id: '__http_server', pathPrefix: '/', upstreams: ['127.0.0.1:1'] },
    ],
    readHandlerBody: true,
    maxRequestBodyBytes,
  })

  server.setRequestHandler(async (request) => ({
    action: 'respond',
    ...(await handler(request)),
  }))

  function listenOptions() {
    if (address.startsWith('unix:')) return { path: address.slice(5) }
    const separator = address.lastIndexOf(':')
    return {
      host: address.slice(0, separator),
      port: Number(address.slice(separator + 1)),
    }
  }

  function waitForListener() {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 10_000
      const attempt = () => {
        const socket = net.connect(listenOptions())
        socket.once('connect', () => {
          socket.destroy()
          resolve()
        })
        socket.once('error', () => {
          socket.destroy()
          if (Date.now() > deadline) reject(new Error('server did not become ready'))
          else setTimeout(attempt, 10)
        })
      }
      attempt()
    })
  }

  async function start() {
    server.start()
    await waitForListener()
  }

  return {
    server,
    url: urlFor(address),
    start,
    stop: () => server.stop(),
    close: () => server.stop(),
  }
}

module.exports = { createServer }
