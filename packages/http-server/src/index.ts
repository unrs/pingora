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

function normalizeListen(listen: string | number): string {
  if (typeof listen === 'number') {
    if (!Number.isInteger(listen) || listen <= 0 || listen > 65535) {
      throw new TypeError('listen port must be a positive integer below 65536')
    }
    return `127.0.0.1:${listen}`
  }
  if (typeof listen === 'string' && listen.length > 0) {
    if (!listen.startsWith('unix:')) {
      const separator = listen.lastIndexOf(':')
      const port = Number(listen.slice(separator + 1))
      if (separator <= 0 || !Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new TypeError('listen must be host:port with a valid port')
      }
    }
    return listen
  }
  throw new TypeError('listen must be a port or address string')
}

function urlFor(listen: string): string {
  return listen.startsWith('unix:') ? listen : `http://${listen}`
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
  const address = normalizeListen(listen)

  function createNativeServer(): Server {
    const native = new Server({
      ...serverOptions,
      listeners: [address],
      // Native routes require an upstream; direct responses never use this one.
      routes: [{ id: '__http_server', pathPrefix: '/', upstreams: ['127.0.0.1:1'] }],
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

  function listenOptions(): net.NetConnectOpts {
    if (address.startsWith('unix:')) return { path: address.slice(5) }
    const separator = address.lastIndexOf(':')
    let host = address.slice(0, separator)
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
    return {
      host,
      port: Number(address.slice(separator + 1)),
    }
  }

  function waitForListener(target: Server, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 10_000
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
        signal?.removeEventListener('abort', abort)
        if (error) reject(error)
        else resolve()
      }

      const abort = () => finish(new Error('server start aborted'))

      if (signal?.aborted) {
        abort()
        return
      }
      signal?.addEventListener('abort', abort, { once: true })

      const attempt = () => {
        if (settled) return
        if (Date.now() > deadline) {
          finish(new Error('server did not become ready'))
          return
        }

        const current = net.connect(listenOptions())
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
            finish(new Error('server did not become ready'))
          } else {
            retry = setTimeout(attempt, 10)
          }
        })
      }
      attempt()
    })
  }

  let started = false
  let serverUsed = false
  let activeStart: AbortController | undefined
  let transition: Promise<void> = Promise.resolve()

  function serialize(operation: () => Promise<void>): Promise<void> {
    const result = transition.then(operation, operation)
    transition = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  function start(): Promise<void> {
    if (activeStart) throw new Error('server is already starting')
    const controller =
      typeof AbortController === 'function' ? new AbortController() : undefined
    activeStart = controller
    return serialize(async () => {
      try {
        if (controller?.signal.aborted) throw new Error('server start aborted')
        if (started) throw new Error('server has already been started')
        if (serverUsed) {
          server = createNativeServer()
          serverUsed = false
        }
        const target = server
        started = true
        try {
          target.start()
          await waitForListener(target, controller?.signal)
        } catch (error) {
          started = false
          // A failed readiness probe must not leave the native server running and
          // block an immediate retry.
          await target.stop().catch(() => {})
          serverUsed = true
          throw error
        }
      } finally {
        activeStart = undefined
      }
    })
  }

  function close(): Promise<void> {
    activeStart?.abort()
    return serialize(async () => {
      if (!started) return
      started = false
      const target = server
      serverUsed = true
      await target.stop()
    })
  }

  return {
    get server() {
      return server
    },
    url: urlFor(address),
    start,
    close,
  }
}
