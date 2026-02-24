// MKPLS-341: Fastify app factory
// Separating buildApp() from the entry point makes the server testable without binding a port.

import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import jwt from '@fastify/jwt'
import { env } from './plugins/env'
import { prismaPlugin } from './plugins/prisma'
import { fanSaleRoutes } from './routes/v1/fan-sale'

export const buildApp = async () => {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === 'test' ? 'silent' : 'info',
      ...(env.NODE_ENV === 'development' && {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true },
        },
      }),
    },
  })

  // Cookies — needed to read the 'at' cookie forwarded from vivid-web-athena
  await app.register(cookie)

  // JWT — signs/verifies tokens with the same secret as vivid-web-athena
  await app.register(jwt, {
    secret: env.AUTH_JWT_SECRET,
    cookie: {
      cookieName: 'at',
      signed: false,
    },
  })

  // Database
  await app.register(prismaPlugin)

  // Routes
  await app.register(fanSaleRoutes, { prefix: '/v1' })

  // Health check — used by load balancers and k8s probes
  app.get('/health', async () => ({ status: 'ok' }))

  return app
}
