// MKPLS-387: Redis sliding window rate limiter.
// Uses a sorted set keyed by userId. Each request is stored as a member with
// score = timestamp. Old members are pruned before counting, keeping the window accurate.

export interface RedisClient {
  zadd(key: string, score: number, member: string): Promise<number>
  zremrangebyscore(key: string, min: number | string, max: number | string): Promise<number>
  zcard(key: string): Promise<number>
  expire(key: string, seconds: number): Promise<number>
}

export interface SlidingWindowResult {
  allowed: boolean
  count: number
  limit: number
}

/**
 * Checks and records a sliding window rate limit.
 * Returns { allowed: false } without recording if the limit is exceeded.
 */
export async function checkSlidingWindow(
  redis: RedisClient,
  key: string,
  limit: number,
  windowMs: number,
): Promise<SlidingWindowResult> {
  const now = Date.now()
  const windowStart = now - windowMs

  // Remove entries older than the window
  await redis.zremrangebyscore(key, '-inf', windowStart)

  // Count remaining entries
  const count = await redis.zcard(key)

  if (count >= limit) {
    return { allowed: false, count, limit }
  }

  // Record this request with a unique member (timestamp + random suffix)
  const member = `${now}-${Math.random().toString(36).slice(2)}`
  await redis.zadd(key, now, member)
  await redis.expire(key, Math.ceil(windowMs / 1000))

  return { allowed: true, count: count + 1, limit }
}
