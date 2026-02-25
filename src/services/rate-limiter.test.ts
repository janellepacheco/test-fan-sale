// MKPLS-387: sliding window rate limiter unit tests

import { checkSlidingWindow, RedisClient } from './rate-limiter'

function makeMockRedis(): jest.Mocked<RedisClient> {
  return {
    zadd: jest.fn().mockResolvedValue(1),
    zremrangebyscore: jest.fn().mockResolvedValue(0),
    zcard: jest.fn().mockResolvedValue(0),
    expire: jest.fn().mockResolvedValue(1),
  }
}

const KEY = 'rate_limit:fan_sale_create:42'
const LIMIT = 5
const WINDOW_MS = 60_000

describe('checkSlidingWindow', () => {
  it('returns allowed=true when count is below limit', async () => {
    const redis = makeMockRedis()
    redis.zcard.mockResolvedValue(3)
    const result = await checkSlidingWindow(redis, KEY, LIMIT, WINDOW_MS)
    expect(result.allowed).toBe(true)
    expect(result.count).toBe(4)
  })

  it('returns allowed=false when count equals limit', async () => {
    const redis = makeMockRedis()
    redis.zcard.mockResolvedValue(5)
    const result = await checkSlidingWindow(redis, KEY, LIMIT, WINDOW_MS)
    expect(result.allowed).toBe(false)
    expect(result.count).toBe(5)
  })

  it('returns allowed=false when count exceeds limit', async () => {
    const redis = makeMockRedis()
    redis.zcard.mockResolvedValue(7)
    const result = await checkSlidingWindow(redis, KEY, LIMIT, WINDOW_MS)
    expect(result.allowed).toBe(false)
  })

  it('prunes expired entries before counting', async () => {
    const redis = makeMockRedis()
    await checkSlidingWindow(redis, KEY, LIMIT, WINDOW_MS)
    expect(redis.zremrangebyscore).toHaveBeenCalledWith(KEY, '-inf', expect.any(Number))
  })

  it('does not record the request when denied', async () => {
    const redis = makeMockRedis()
    redis.zcard.mockResolvedValue(5)
    await checkSlidingWindow(redis, KEY, LIMIT, WINDOW_MS)
    expect(redis.zadd).not.toHaveBeenCalled()
  })

  it('records the request when allowed', async () => {
    const redis = makeMockRedis()
    redis.zcard.mockResolvedValue(2)
    await checkSlidingWindow(redis, KEY, LIMIT, WINDOW_MS)
    expect(redis.zadd).toHaveBeenCalledWith(KEY, expect.any(Number), expect.any(String))
  })

  it('sets expiry on the key after recording', async () => {
    const redis = makeMockRedis()
    redis.zcard.mockResolvedValue(0)
    await checkSlidingWindow(redis, KEY, LIMIT, WINDOW_MS)
    expect(redis.expire).toHaveBeenCalledWith(KEY, Math.ceil(WINDOW_MS / 1000))
  })

  it('exposes limit in the result', async () => {
    const redis = makeMockRedis()
    const result = await checkSlidingWindow(redis, KEY, LIMIT, WINDOW_MS)
    expect(result.limit).toBe(LIMIT)
  })
})
