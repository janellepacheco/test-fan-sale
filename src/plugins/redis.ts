// MKPLS-353: Redis plugin — decorates app with a nullable redis client.
// Optional by design: if REDIS_URL is not set the cache is simply skipped
// and all price-comps queries hit the DB. No hard start-up failure.

import fp from 'fastify-plugin'
import { FastifyPluginAsync } from 'fastify'
import { createClient, RedisClientType } from 'redis'
import { env } from './env'

declare module 'fastify' {
  interface FastifyInstance {
    redis: RedisClientType | null
  }
}

const redisPlugin: FastifyPluginAsync = fp(async (app) => {
  if (!env.REDIS_URL) {
    app.log.warn('REDIS_URL not set — price-comps caching disabled')
    app.decorate('redis', null)
    return
  }

  const client = createClient({ url: env.REDIS_URL }) as RedisClientType

  client.on('error', (err) => app.log.error({ err }, 'Redis client error'))

  await client.connect()

  app.decorate('redis', client)

  app.addHook('onClose', async () => {
    await client.quit()
  })
})

export { redisPlugin }
