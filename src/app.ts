// MKPLS-341: Fastify app factory
// Separating buildApp() from the entry point makes the server testable without binding a port.

import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import jwt from '@fastify/jwt'
import { env } from './plugins/env'
import { prismaPlugin } from './plugins/prisma'
import redisPlugin from './plugins/redis'
import { fanSaleRoutes } from './routes/v1/fan-sale'
import { inventoryRoutes } from './routes/v1/inventory'
import { adminFanSaleRoutes } from './routes/admin/fan-sale'

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

  await app.register(cookie)

  // The 'at' cookie in vivid-web-athena is a JSON object, not a JWT — auth arrives
  // as Authorization: Bearer <token> (the token field extracted from the at cookie by fanSaleService).
  // TODO: if token is a Cognito RS256 JWT, replace secret with JWKS verification.
  await app.register(jwt, {
    secret: env.AUTH_JWT_SECRET,
  })

  // Database
  await app.register(prismaPlugin)

  // Redis — rate limiting and caching
  await app.register(redisPlugin)

  // Routes
  await app.register(fanSaleRoutes, { prefix: '/v1' })
  await app.register(inventoryRoutes, { prefix: '/v1' })
  await app.register(adminFanSaleRoutes, { prefix: '/v1' })

  // Health check — used by load balancers and k8s probes
  app.get('/health', async () => ({ status: 'ok' }))

  return app
}
