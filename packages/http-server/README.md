# @pingora/http-server

Direct HTTP server facade for [`pingora`](https://www.npmjs.com/package/pingora),
the Node.js binding for Cloudflare Pingora.

```sh
npm install @pingora/http-server
```

## Usage

```js
import { createServer } from '@pingora/http-server'

async function main() {
  const app = createServer({
    listen: 3000,
    maxRequestBodyBytes: 1_048_576,
    handler: async (request) => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: request.path,
        bytes: request.body ? request.body.length : 0,
      }),
    }),
  })

  await app.start()

  const shutdown = async () => {
    await app.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
```

`start()` holds a ref'd timer so the Node.js process stays alive while the
native listener is running. Set `unref: true` when embedding the server and
another handle should own the process lifetime. The example uses ESM, supported
by Node.js 12.20+; it avoids top-level await for that floor.

## API

### `createServer(handler | options)`

`handler` receives the request view exposed by `pingora` and returns:

```ts
{
  status?: number
  headers?: Record<string, string>
  body?: string | Buffer
}
```

Native routes can answer without entering JavaScript:

```js
const app = createServer({
  routes: [
    {
      path: '/health',
      respond: { status: 200, body: 'ok' },
    },
  ],
  handler: async (request) => ({ body: request.path }),
})
```

A matching native route is handled entirely in Rust and skips the handler. The
handler is the fallback for requests no native route matched, and may be omitted
when every route is native. If routes are added at runtime to a handler-only
server, set `server.handlerOnlyOnUnmatched: true` to opt those routes into the
native fast path.

Options:

| Option | Default | Description |
| --- | --- | --- |
| `handler` | none | JS fallback for requests not matched by a native route. |
| `routes` | `[]` | Native static or upstream routes. |
| `listen` | `127.0.0.1:8080` | TCP `host:port` or `unix:/path`. |
| `maxRequestBodyBytes` | `1048576` | Buffered request-body limit. |
| `unref` | `false` | Do not keep the Node.js process alive after `start()`. |
| `server` | none | Remaining `pingora` `ServerOptions`, including `handlerTimeoutMs` (default `1000`) and `handlerOnlyOnUnmatched` (defaults to `true` when `routes` is non-empty). |

The returned object exposes:

- `server` — current native `pingora` server for status/metrics; its `start()` and
  `stop()` delegate to the facade lifecycle (replaced on the next `start()` after
  close or a failed start). A replaced handle's `start()` rejects; its `stop()`
  only retires that old native instance.
- `url`
- `start(): Promise<void>`
- `close(): Promise<void>`

`start()` waits until the listener is reachable. `close()` stops the current
native server. Lifecycle calls must be awaited and cannot overlap: calling
`close()` while `start()` is pending rejects, and vice versa.

## Limitations

- Request bodies are buffered, not streamed.
- Response bodies are buffered; response streaming is not implemented yet.
- Body reading is bounded by `handlerTimeoutMs`; large/slow uploads can return
  `408` before the handler runs.
