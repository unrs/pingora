import type { Server, ServerOptions, RequestView } from 'pingora'

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
  stop(): Promise<void>
  close(): Promise<void>
}

export function createServer(handler: HttpServerOptions['handler']): HttpServer
export function createServer(options: HttpServerOptions): HttpServer
