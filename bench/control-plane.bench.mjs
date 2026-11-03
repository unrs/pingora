import { afterAll, beforeAll, test } from 'vitest'

import { Server } from '../index.js'

// Control-plane benchmarks: synchronous calls into the native binding that do
// not touch the network (route parsing and validation, route table updates,
// metrics rendering).

const ROUTE_COUNT = 100

function makeRoute(index) {
  return {
    id: `route-${index}`,
    host: [`svc-${index}.example.com`, `*.svc-${index}.internal`],
    pathPrefix: `/api/v${index % 4}/svc-${index}`,
    methods: ['GET', 'POST', 'PUT'],
    matchHeaders: { 'x-tenant': `tenant-${index % 8}` },
    upstreams: [
      `127.0.0.1:${10_000 + index}`,
      { address: `127.0.0.2:${10_000 + index}`, weight: 3 },
      { address: `127.0.0.3:${10_000 + index}`, weight: 1 },
    ],
    strategy: 'weighted_round_robin',
    requestHeaders: { 'x-route': `route-${index}`, 'x-forwarded-proto': 'http' },
    removeRequestHeaders: ['x-internal-debug'],
    responseHeaders: { 'x-served-by': 'pingora' },
    removeResponseHeaders: ['server'],
    timeoutMs: 5_000,
  }
}

const routes = Array.from({ length: ROUTE_COUNT }, (_, index) => makeRoute(index))
const extraRoute = makeRoute(ROUTE_COUNT)

function newServer() {
  return new Server({
    routes,
    threads: 1,
    gracePeriodMs: 0,
    shutdownTimeoutMs: 0,
    logLevel: 'off',
  })
}

let server

beforeAll(() => {
  server = newServer()
})

afterAll(async () => {
  await server?.stop()
})

test(`construct server with ${ROUTE_COUNT} routes`, async ({ bench }) => {
  await bench('new Server', () => {
    newServer()
  }).run()
})

test('add and remove a route', async ({ bench }) => {
  await bench('addRoute + removeRoute', () => {
    const id = server.addRoute(extraRoute)
    server.removeRoute(id)
  }).run()
})

test('read metrics', async ({ bench }) => {
  await bench.compare(
    bench('metrics', () => {
      server.metrics()
    }),
    bench('routeMetrics', () => {
      server.routeMetrics('route-50')
    }),
    bench(`metricsPrometheus (${ROUTE_COUNT} routes)`, () => {
      server.metricsPrometheus()
    }),
  )
})
