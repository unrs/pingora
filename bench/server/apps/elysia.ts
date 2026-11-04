import { Elysia } from 'elysia'
import { node } from '@elysiajs/node'

const port = Number(process.env.PORT ?? 8080)
const app = new Elysia({ adapter: node() })
  .get('/plaintext', () => 'Hello, World!')
  .get('/json', () => ({ message: 'Hello, World!' }))
  .get('/users/:id', ({ params }) => ({ id: params.id }))

app.listen(port)
process.once('SIGTERM', () => process.exit(0))
