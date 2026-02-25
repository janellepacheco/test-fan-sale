// MKPLS-387: checkListingCap and makeRateLimitMiddleware unit tests

import { checkListingCap, LISTING_CAP } from './checkListingCap'
import { makeRateLimitMiddleware, RATE_LIMIT } from './rateLimit'
import { RedisClient } from '../services/rate-limiter'

// ---------------------------------------------------------------------------
// Shared mocks
// ---------------------------------------------------------------------------

const mockCount = jest.fn()
const mockPrisma = { fanListing: { count: mockCount } }

const mockReply = {
  code: jest.fn().mockReturnThis(),
  send: jest.fn().mockReturnThis(),
}

function makeRequest(accountId = 1, redisOverride?: RedisClient) {
  return {
    user: { accountId },
    server: { prisma: mockPrisma, redis: redisOverride },
  }
}

beforeEach(() => jest.clearAllMocks())

// ---------------------------------------------------------------------------
// checkListingCap
// ---------------------------------------------------------------------------

describe('checkListingCap', () => {
  it('passes through when seller has fewer than 10 active listings', async () => {
    mockCount.mockResolvedValue(9)
    await checkListingCap(makeRequest() as never, mockReply as never)
    expect(mockReply.code).not.toHaveBeenCalled()
  })

  it('returns 429 when seller has exactly 10 active listings', async () => {
    mockCount.mockResolvedValue(10)
    await checkListingCap(makeRequest() as never, mockReply as never)
    expect(mockReply.code).toHaveBeenCalledWith(429)
    const sent = mockReply.send.mock.calls[0][0]
    expect(sent.code).toBe('LISTING_CAP_EXCEEDED')
    expect(sent.message).toContain(`${LISTING_CAP}`)
  })

  it('returns 429 when seller has more than 10 active listings', async () => {
    mockCount.mockResolvedValue(15)
    await checkListingCap(makeRequest() as never, mockReply as never)
    expect(mockReply.code).toHaveBeenCalledWith(429)
  })

  it('queries only ACTIVE listings for the correct seller', async () => {
    mockCount.mockResolvedValue(0)
    await checkListingCap(makeRequest(42) as never, mockReply as never)
    expect(mockCount).toHaveBeenCalledWith({
      where: { sellerId: 42, status: 'ACTIVE' },
    })
  })
})

// ---------------------------------------------------------------------------
// makeRateLimitMiddleware
// ---------------------------------------------------------------------------

function makeMockRedis(zcard = 0): jest.Mocked<RedisClient> {
  return {
    zadd: jest.fn().mockResolvedValue(1),
    zremrangebyscore: jest.fn().mockResolvedValue(0),
    zcard: jest.fn().mockResolvedValue(zcard),
    expire: jest.fn().mockResolvedValue(1),
  }
}

describe('makeRateLimitMiddleware', () => {
  it('passes through when under the rate limit', async () => {
    const redis = makeMockRedis(2)
    const mw = makeRateLimitMiddleware(() => redis, { limit: 5, windowMs: 60_000 })
    await mw(makeRequest(1, redis) as never, mockReply as never)
    expect(mockReply.code).not.toHaveBeenCalled()
  })

  it('returns 429 with RATE_LIMIT_EXCEEDED code when limit is hit', async () => {
    const redis = makeMockRedis(5)
    const mw = makeRateLimitMiddleware(() => redis, { limit: 5, windowMs: 60_000 })
    await mw(makeRequest(1, redis) as never, mockReply as never)
    expect(mockReply.code).toHaveBeenCalledWith(429)
    const sent = mockReply.send.mock.calls[0][0]
    expect(sent.code).toBe('RATE_LIMIT_EXCEEDED')
  })

  it('uses per-user Redis key', async () => {
    const redis = makeMockRedis(0)
    const mw = makeRateLimitMiddleware(() => redis, { limit: 5, windowMs: 60_000 })
    await mw(makeRequest(99, redis) as never, mockReply as never)
    const key = redis.zadd.mock.calls[0][0]
    expect(key).toBe('rate_limit:fan_sale_create:99')
  })

  it('RATE_LIMIT_EXCEEDED message is distinct from LISTING_CAP_EXCEEDED', async () => {
    // Rate limit response
    const redis = makeMockRedis(RATE_LIMIT)
    const mw = makeRateLimitMiddleware(() => redis, { limit: RATE_LIMIT, windowMs: 60_000 })
    await mw(makeRequest() as never, mockReply as never)
    const rateSent = mockReply.send.mock.calls[0][0]

    jest.clearAllMocks()
    mockCount.mockResolvedValue(LISTING_CAP)

    // Listing cap response
    await checkListingCap(makeRequest() as never, mockReply as never)
    const capSent = mockReply.send.mock.calls[0][0]

    expect(rateSent.code).toBe('RATE_LIMIT_EXCEEDED')
    expect(capSent.code).toBe('LISTING_CAP_EXCEEDED')
    expect(rateSent.message).not.toBe(capSent.message)
  })

  it('respects injected limit override', async () => {
    const redis = makeMockRedis(3)
    const mw = makeRateLimitMiddleware(() => redis, { limit: 3, windowMs: 60_000 })
    await mw(makeRequest() as never, mockReply as never)
    expect(mockReply.code).toHaveBeenCalledWith(429)
  })
})
