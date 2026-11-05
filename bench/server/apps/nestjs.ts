import 'reflect-metadata'

import { Controller, Get, Header, Module, Param } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import type { INestApplication } from '@nestjs/common'

@Controller()
class BenchController {
  @Get('plaintext')
  @Header('content-type', 'text/plain')
  plaintext(): string {
    return 'Hello, World!'
  }

  @Get('json')
  json(): { message: string } {
    return { message: 'Hello, World!' }
  }

  @Get('users/:id')
  user(@Param('id') id: string): { id: string } {
    return { id }
  }
}

@Module({ controllers: [BenchController] })
class AppModule {}

const port = Number(process.env.PORT ?? 8080)
const app: INestApplication<unknown> = await NestFactory.create(AppModule, { logger: false })
const express = app.getHttpAdapter().getInstance() as { disable(name: string): void }
express.disable('etag')
express.disable('x-powered-by')
await app.listen(port, '0.0.0.0')
process.once('SIGTERM', () => {
  void app.close().then(() => process.exit(0))
})
