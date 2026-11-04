# @pingora/http-server

Direct HTTP server facade for [`pingora`](https://www.npmjs.com/package/pingora),
the Node.js binding for Cloudflare Pingora.

```sh
npm install @pingora/http-server
```

## Usage

```js
import { createServer } from '@pingora/http-server'

const app = createServer({
  listen: 3000,
  maxRequestBodyBytes: 1_048_576,
  handler: async (request) => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      path: request.path,
      bytes: request.body?.length ?? 0,
    }),
  }),
})

await app.start()
await app.close()
```

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
| `server` | none | Remaining `pingora` `ServerOptions`. |

The returned object exposes:

- `server` — current native `pingora` server
- `url`
- `start(): Promise<void>`
- `close(): Promise<void>`

`start()` waits until the listener is reachable. `close()` stops the current
native server. Lifecycle calls are serialized.

When global `AbortController` is available, `close()` aborts an in-flight
`start()` immediately. Node.js versions without it still work, but `close()`
waits for the current lifecycle transition; applications that need immediate
cancellation can install an `AbortController` polyfill.

## Limitations

- Request bodies are buffered, not streamed.
- Response bodies are buffered; response streaming is not implemented yet.
- The facade installs a placeholder route because native routes currently
  require an upstream; direct handler responses never use it.
