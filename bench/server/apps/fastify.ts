import Fastify from 'fastify'

const port = Number(process.env.PORT ?? 8080)
const app = Fastify({ logger: false })

app.get('/plaintext', async (_request, reply) => {
  reply.type('text/plain')
  return 'Hello, World!'
})
app.get('/json', async () => ({ message: 'Hello, World!' }))
app.get<{ Params: { id: string } }>('/users/:id', async (request) => ({ id: request.params.id }))

await app.listen({ port, host: '0.0.0.0' })
process.once('SIGTERM', () => {
  void app.close().then(() => process.exit(0))
})
