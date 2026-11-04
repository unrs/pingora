import Koa from 'koa'
import Router from '@koa/router'

const port = Number(process.env.PORT ?? 8080)
const app = new Koa()
const router = new Router()

router.get('/plaintext', (context) => {
  context.type = 'text/plain'
  context.body = 'Hello, World!'
})
router.get('/json', (context) => {
  context.body = { message: 'Hello, World!' }
})
router.get('/users/:id', (context) => {
  context.body = { id: context.params.id }
})

app.use(router.routes()).use(router.allowedMethods())
const server = app.listen(port, '0.0.0.0')
process.once('SIGTERM', () => server.close(() => process.exit(0)))
