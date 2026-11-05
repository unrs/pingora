import express, { type Request, type Response } from 'express'

type BenchRequest = Request<
  Record<string, string>,
  unknown,
  unknown,
  Record<string, string>,
  Record<string, unknown>
>
type BenchResponse = Response<unknown, Record<string, unknown>>

const port = Number(process.env.PORT ?? 8080)
const app = express()
app.disable('x-powered-by')
app.disable('etag')

app.get('/plaintext', (_request: BenchRequest, response: BenchResponse) => {
  response.type('text/plain').send('Hello, World!')
})
app.get('/json', (_request: BenchRequest, response: BenchResponse) => {
  response.json({ message: 'Hello, World!' })
})
app.get('/users/:id', (request: BenchRequest, response: BenchResponse) => {
  response.json({ id: request.params.id })
})

const server = app.listen(port, '0.0.0.0')
process.once('SIGTERM', () => server.close(() => process.exit(0)))
