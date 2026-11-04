import { Hono } from 'hono'
import { serve } from '@hono/node-server'

const port = Number(process.env.PORT ?? 8080)
const app = new Hono()

app.get('/plaintext', (context) => context.text('Hello, World!'))
app.get('/json', (context) => context.json({ message: 'Hello, World!' }))
app.get('/users/:id', (context) => context.json({ id: context.req.param('id') }))

const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' })
process.once('SIGTERM', () => server.close(() => process.exit(0)))
