// MKPLS-387: Rate limit preHandler for POST /fan-sale/listings.
// Max 5 create attempts per hour per userId, enforced via Redis sliding window.
// Error message is distinct from the listing cap 429 (code: RATE_LIMIT_EXCEEDED).

import { FastifyReply, FastifyRequest } from 'fastify'
import { RedisClient, checkSlidingWindow } from '../services/rate-limiter'

export const RATE_LIMIT = 5
export const RATE_WINDOW_MS = 60 * 60 * 1000 // 1 hour

/**
 * Factory — accepts an injectable RedisClient for testability.
 * In production, pass request.server.redis.
 */
export function makeRateLimitMiddleware(
  getRedis: (request: FastifyRequest) => RedisClient,
  opts?: { limit?: number; windowMs?: number },
) {
  const limit = opts?.limit ?? RATE_LIMIT
  const windowMs = opts?.windowMs ?? RATE_WINDOW_MS

  return async function rateLimitMiddleware(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const { accountId } = request.user
    const key = `rate_limit:fan_sale_create:${accountId}`
    const redis = getRedis(request)

    const result = await checkSlidingWindow(redis, key, limit, windowMs)

    if (!result.allowed) {
      return reply.code(429).send({
        error: 'Too Many Requests',
        message: 'Rate limit exceeded. Maximum 5 listing attempts per hour.',
        statusCode: 429,
        code: 'RATE_LIMIT_EXCEEDED',
      })
    }
  }
}

/** Default instance that reads redis from the Fastify server decorator. */
export const rateLimitMiddleware = makeRateLimitMiddleware(
  (req) => req.server.redis,
)
