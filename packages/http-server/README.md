# @pingora/http-server

Direct HTTP server facade for [`pingora`](https://www.npmjs.com/package/pingora),
the Node.js binding for Cloudflare Pingora.

```sh
npm install @pingora/http-server
```

## Usage

```js
const { createServer } = require('@pingora/http-server')

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

The CommonJS example runs on Node.js 12. Modern Node.js can use
`import { createServer } from '@pingora/http-server'`.

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

Options:

| Option | Default | Description |
| --- | --- | --- |
| `handler` | required | Direct request handler. |
| `listen` | `127.0.0.1:8080` | TCP `host:port` or `unix:/path`. |
| `maxRequestBodyBytes` | `1048576` | Required finite buffered body limit. |
| `server` | none | Remaining `pingora` `ServerOptions`, including `handlerTimeoutMs` (default `1000`). |

The returned object exposes:

- `server` — current native `pingora` server (replaced after close or a failed start)
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
