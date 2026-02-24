// MKPLS-341: Service entry point — boots Fastify, binds to PORT/HOST from validated env

import { buildApp } from './app'
import { env } from './plugins/env'

const start = async () => {
  const app = await buildApp()

  try {
    await app.listen({ port: env.PORT, host: env.HOST })
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

start()
