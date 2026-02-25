// MKPLS-387: Redis plugin — decorates the Fastify instance with app.redis (ioredis).
// Used by the rate limit middleware on listing creation.

import fp from 'fastify-plugin'
import Redis from 'ioredis'
import { FastifyInstance } from 'fastify'
import { env } from './env'

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis
  }
}

async function redisPlugin(app: FastifyInstance) {
  const redis = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  })

  await redis.connect()

  app.decorate('redis', redis)

  app.addHook('onClose', async () => {
    await redis.quit()
  })
}

export default fp(redisPlugin, { name: 'redis' })
