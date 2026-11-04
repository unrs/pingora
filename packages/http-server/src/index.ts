import net from 'net'

import { Server } from 'pingora'
import type { RequestView, ServerOptions } from 'pingora'

export interface HttpServerResponse {
  status?: number
  headers?: Record<string, string>
  body?: string | Buffer
}

export interface HttpServerOptions {
  handler: (request: RequestView) => HttpServerResponse | Promise<HttpServerResponse>
  listen?: string | number
  maxRequestBodyBytes?: number
  server?: Omit<ServerOptions, 'listeners' | 'routes' | 'readHandlerBody' | 'maxRequestBodyBytes'>
}

export interface HttpServer {
  server: Server
  url: string
  start(): Promise<void>
  close(): Promise<void>
}

const DEFAULT_LISTEN = '127.0.0.1:8080'
const DEFAULT_MAX_BODY = 1_048_576
const READY_TIMEOUT_MS = 10_000

interface ListenConfig {
  address: string
  connect: net.NetConnectOpts
  url: string
}

function parseListen(listen: string | number): ListenConfig {
  if (typeof listen === 'number') {
    if (!Number.isInteger(listen) || listen <= 0 || listen > 65535) {
      throw new TypeError('listen port must be a positive integer below 65536')
    }
    return {
      address: `127.0.0.1:${listen}`,
      connect: { host: '127.0.0.1', port: listen },
      url: `http://127.0.0.1:${listen}`,
    }
  }

  if (typeof listen !== 'string' || listen.length === 0) {
    throw new TypeError('listen must be a port or address string')
  }

  if (listen.startsWith('unix:')) {
    const path = listen.slice(5)
    if (!path) throw new TypeError('listen must include a Unix socket path')
    return { address: listen, connect: { path }, url: listen }
  }

  if (listen.includes('://')) {
    throw new TypeError('listen must be host:port or unix:/path')
  }

  const separator = listen.lastIndexOf(':')
  const port = Number(listen.slice(separator + 1))
  const host = listen.slice(0, separator)
  if (separator <= 0 || !Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new TypeError('listen must be host:port with a valid port')
  }
  const bracketed = host.startsWith('[') && host.endsWith(']')
  if (host.includes(':') && !bracketed) {
    throw new TypeError('IPv6 listen addresses must use [host]:port')
  }
  const connectHost = bracketed ? host.slice(1, -1) : host
  const urlHost = connectHost === '0.0.0.0' ? '127.0.0.1' : connectHost === '::' ? '::1' : connectHost
  const formattedHost = urlHost.includes(':') ? `[${urlHost}]` : urlHost
  return {
    address: listen,
    connect: { host: connectHost, port },
    url: `http://${formattedHost}:${port}`,
  }
}


export function createServer(handler: HttpServerOptions['handler']): HttpServer
export function createServer(options: HttpServerOptions): HttpServer
export function createServer(
  options: HttpServerOptions | HttpServerOptions['handler'],
): HttpServer {
  if (typeof options === 'function') options = { handler: options }
  const {
    handler,
    listen = DEFAULT_LISTEN,
    maxRequestBodyBytes = DEFAULT_MAX_BODY,
    server: serverOptions = {},
  } = options
  if (typeof handler !== 'function') throw new TypeError('createServer requires a handler function')
  if (
    !Number.isSafeInteger(maxRequestBodyBytes) ||
    maxRequestBodyBytes <= 0 ||
    maxRequestBodyBytes > 0xffff_ffff
  ) {
    throw new TypeError('maxRequestBodyBytes must be a positive u32 integer')
  }
  const { address, connect, url } = parseListen(listen)

  function createNativeServer(): Server {
    const native = new Server({
      ...serverOptions,
      listeners: [address],
      readHandlerBody: true,
      maxRequestBodyBytes,
    })
    native.setRequestHandler(async (request) => ({
      ...(await handler(request)),
      action: 'respond',
    }))
    return native
  }

  let server = createNativeServer()


  function waitForListener(target: Server): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + READY_TIMEOUT_MS
      let settled = false
      let socket: net.Socket | undefined
      let timer: NodeJS.Timeout | undefined
      let retry: NodeJS.Timeout | undefined

      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (retry) clearTimeout(retry)
        socket?.destroy()
        if (error) reject(error)
        else resolve()
      }

      const attempt = () => {
        if (settled) return
        if (Date.now() > deadline) {
          const reason = target.status().error
          finish(new Error(reason || 'server did not become ready'))
          return
        }

        const current = net.connect(connect)
        socket = current
        timer = setTimeout(
          () => current.destroy(new Error('connect attempt timed out')),
          Math.max(0, deadline - Date.now()),
        )
        current.once('connect', () => finish())
        current.once('error', () => {
          if (settled) return
          if (timer) {
            clearTimeout(timer)
            timer = undefined
          }
          current.destroy()
          const status = target.status()
          if (status.state === 'failed' || status.state === 'stopped') {
            finish(new Error(status.error || `server ${status.state}`))
          } else if (Date.now() > deadline) {
            const reason = target.status().error
            finish(new Error(reason || 'server did not become ready'))
          } else {
            retry = setTimeout(attempt, 10)
          }
        })
      }
      attempt()
    })
  }

  type Lifecycle = 'idle' | 'starting' | 'running' | 'closing'
  let lifecycle: Lifecycle = 'idle'
  let serverUsed = false
  let closing: Promise<void> | undefined

  async function start(): Promise<void> {
    if (lifecycle === 'running') throw new Error('server has already been started')
    if (lifecycle !== 'idle') throw new Error('server lifecycle transition in progress')
    lifecycle = 'starting'
    try {
      if (serverUsed) {
        server = createNativeServer()
        serverUsed = false
      }
      const target = server
      target.start()
      await waitForListener(target)
      lifecycle = 'running'
    } catch (error) {
      await server.stop().catch(() => {})
      serverUsed = true
      lifecycle = 'idle'
      throw error
    }
  }

  async function close(): Promise<void> {
    if (lifecycle === 'starting') {
      throw new Error('server is starting; await start() before close()')
    }
    if (lifecycle === 'closing') return closing
    if (lifecycle !== 'running') return

    lifecycle = 'closing'
    const target = server
    const operation = (async () => {
      try {
        await target.stop()
      } finally {
        serverUsed = true
        lifecycle = 'idle'
        closing = undefined
      }
    })()
    closing = operation
    return operation
  }

  return {
    get server() {
      return server
    },
    url,
    start,
    close,
  }
}
