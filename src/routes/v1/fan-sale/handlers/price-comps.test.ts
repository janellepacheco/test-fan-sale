// MKPLS-353: price-comps tests
//
// Unit tests cover the pure stat helpers (sortedPrices, median, buildCompsResponse,
// cacheKey) — no I/O.
// Integration tests exercise cache HIT, cache MISS, fallback to event-level,
// and the 400 error path via app.inject().

import { sortedPrices, median, buildCompsResponse, cacheKey } from './price-comps'

// ---------------------------------------------------------------------------
// sortedPrices
// ---------------------------------------------------------------------------

describe('sortedPrices', () => {
  it('returns prices in ascending order', () => {
    expect(sortedPrices([50, 20, 80, 10])).toEqual([10, 20, 50, 80])
  })

  it('does not mutate the input array', () => {
    const input = [30, 10, 20]
    sortedPrices(input)
    expect(input).toEqual([30, 10, 20])
  })

  it('handles a single-element array', () => {
    expect(sortedPrices([42])).toEqual([42])
  })

  it('handles an empty array', () => {
    expect(sortedPrices([])).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// median
// ---------------------------------------------------------------------------

describe('median', () => {
  it('returns the middle value for odd-length arrays', () => {
    expect(median([10, 20, 30])).toBe(20)
  })

  it('averages the two middle values for even-length arrays', () => {
    expect(median([10, 20, 30, 40])).toBe(25)
  })

  it('rounds the average to 2 decimal places', () => {
    expect(median([10, 11])).toBe(10.5)
    expect(median([10, 13])).toBe(11.5)
  })

  it('returns 0 for an empty array', () => {
    expect(median([])).toBe(0)
  })

  it('returns the single element for a one-element array', () => {
    expect(median([99])).toBe(99)
  })
})

// ---------------------------------------------------------------------------
// buildCompsResponse
// ---------------------------------------------------------------------------

describe('buildCompsResponse', () => {
  const rows = [
    { id: 'l1', section: '101', row: 'A', askingPrice: 50,  quantity: 1 },
    { id: 'l2', section: '101', row: 'A', askingPrice: 80,  quantity: 1 },
    { id: 'l3', section: '101', row: 'B', askingPrice: 100, quantity: 1 },
  ]

  it('calculates min, max, median and returns comps array', () => {
    const result = buildCompsResponse('evt-1', rows)
    expect(result.eventId).toBe('evt-1')
    expect(result.minPrice).toBe(50)
    expect(result.maxPrice).toBe(100)
    expect(result.suggestedPrice).toBe(80)   // median of [50, 80, 100]
    expect(result.comps).toHaveLength(3)
  })

  it('returns zeros and empty comps for no listings', () => {
    const result = buildCompsResponse('evt-empty', [])
    expect(result.minPrice).toBe(0)
    expect(result.maxPrice).toBe(0)
    expect(result.suggestedPrice).toBe(0)
    expect(result.comps).toHaveLength(0)
  })

  it('maps each row to a PriceComp with the correct shape', () => {
    const result = buildCompsResponse('evt-1', [rows[0]])
    expect(result.comps[0]).toEqual({
      listingId: 'l1',
      section: '101',
      row: 'A',
      askingPrice: 50,
      quantity: 1,
    })
  })
})

// ---------------------------------------------------------------------------
// cacheKey
// ---------------------------------------------------------------------------

describe('cacheKey', () => {
  it('produces an event-only key when no section/row provided', () => {
    expect(cacheKey('evt-1')).toBe('price-comps:evt-1')
  })

  it('includes section when provided', () => {
    expect(cacheKey('evt-1', '101')).toBe('price-comps:evt-1:s:101')
  })

  it('includes section and row when both provided', () => {
    expect(cacheKey('evt-1', '101', 'A')).toBe('price-comps:evt-1:s:101:r:A')
  })

  it('omits section prefix when only row is provided', () => {
    expect(cacheKey('evt-1', undefined, 'A')).toBe('price-comps:evt-1:r:A')
  })
})

// ---------------------------------------------------------------------------
// Integration tests — full HTTP with mocked Prisma and Redis
// ---------------------------------------------------------------------------

describe('GET /v1/fan-sale/price-comps', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any
  let mockPrisma: { $connect: jest.Mock; $disconnect: jest.Mock; fanListing: { findMany: jest.Mock } }
  let mockRedis: { get: jest.Mock; setEx: jest.Mock } | null

  beforeAll(async () => {
    jest.resetModules()

    mockRedis = { get: jest.fn(), setEx: jest.fn().mockResolvedValue('OK') }

    mockPrisma = {
      $connect: jest.fn().mockResolvedValue(undefined),
      $disconnect: jest.fn().mockResolvedValue(undefined),
      fanListing: { findMany: jest.fn() },
    }

    jest.doMock('../../../../plugins/prisma', () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fp = require('fastify-plugin')
      const prisma = mockPrisma
      return {
        prismaPlugin: fp(async (fastify: { decorate: Function; addHook: Function }) => {
          fastify.decorate('prisma', prisma)
          fastify.addHook('onClose', jest.fn())
        }),
      }
    })

    jest.doMock('../../../../plugins/redis', () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fp = require('fastify-plugin')
      const redis = mockRedis
      return {
        redisPlugin: fp(async (fastify: { decorate: Function; addHook: Function }) => {
          fastify.decorate('redis', redis)
          fastify.addHook('onClose', jest.fn())
        }),
      }
    })

    jest.doMock('../../../../services/hermes', () => ({
      HermesClient: jest.fn(() => ({ getOrder: jest.fn() })),
    }))

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildApp } = require('../../../../app')
    app = await buildApp()
  })

  afterAll(async () => {
    if (app) await app.close()
    jest.resetModules()
  })

  beforeEach(() => {
    jest.clearAllMocks()
    mockRedis!.get.mockResolvedValue(null)          // default: cache miss
    mockRedis!.setEx.mockResolvedValue('OK')
    mockPrisma.fanListing.findMany.mockResolvedValue([])
  })

  function makeToken(accountId = 42) {
    return app.jwt.sign({ accountId, refreshToken: 'r', tokenExpiresAt: 9_999_999_999, token: 't' })
  }

  function makeRows(count: number, basePrice = 50) {
    return Array.from({ length: count }, (_, i) => ({
      id: `lst-${i}`,
      section: '101',
      row: 'A',
      askingPrice: basePrice + i * 10,
    }))
  }

  // -------------------------------------------------------------------------
  // 200 — happy path (cache miss → DB query)
  // -------------------------------------------------------------------------

  it('200 — returns comps, min, max, median from DB on cache miss', async () => {
    mockPrisma.fanListing.findMany.mockResolvedValue(makeRows(3, 40))

    const res = await app.inject({
      method: 'GET',
      url: '/v1/fan-sale/price-comps?eventId=evt-1&section=101&row=A',
      cookies: { at: makeToken() },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.eventId).toBe('evt-1')
    expect(body.comps).toHaveLength(3)
    expect(body.minPrice).toBe(40)
    expect(body.maxPrice).toBe(60)
    expect(body.suggestedPrice).toBe(50)
    expect(res.headers['x-cache']).toBe('MISS')
  })

  it('writes the result to Redis after a cache miss', async () => {
    mockPrisma.fanListing.findMany.mockResolvedValue(makeRows(3, 40))

    await app.inject({
      method: 'GET',
      url: '/v1/fan-sale/price-comps?eventId=evt-1',
      cookies: { at: makeToken() },
    })

    expect(mockRedis!.setEx).toHaveBeenCalledWith(
      'price-comps:evt-1',
      300,
      expect.any(String),
    )
  })

  // -------------------------------------------------------------------------
  // 200 — cache HIT
  // -------------------------------------------------------------------------

  it('200 — returns cached response on cache hit without hitting DB', async () => {
    const cached: import('../../../../types').PriceCompsResponse = {
      eventId: 'evt-1',
      comps: [],
      suggestedPrice: 75,
      minPrice: 70,
      maxPrice: 80,
    }
    mockRedis!.get.mockResolvedValue(JSON.stringify(cached))

    const res = await app.inject({
      method: 'GET',
      url: '/v1/fan-sale/price-comps?eventId=evt-1',
      cookies: { at: makeToken() },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).suggestedPrice).toBe(75)
    expect(res.headers['x-cache']).toBe('HIT')
    expect(mockPrisma.fanListing.findMany).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Fallback — fewer than 3 listings in scoped query
  // -------------------------------------------------------------------------

  it('falls back to event-level query when scoped result has < 3 listings', async () => {
    // First call (section-scoped): 2 rows — triggers fallback
    // Second call (event-level): 5 rows
    mockPrisma.fanListing.findMany
      .mockResolvedValueOnce(makeRows(2, 30))   // scoped → too few
      .mockResolvedValueOnce(makeRows(5, 30))   // event-level fallback

    const res = await app.inject({
      method: 'GET',
      url: '/v1/fan-sale/price-comps?eventId=evt-1&section=101',
      cookies: { at: makeToken() },
    })

    expect(res.statusCode).toBe(200)
    expect(mockPrisma.fanListing.findMany).toHaveBeenCalledTimes(2)
    expect(JSON.parse(res.body).comps).toHaveLength(5)
  })

  it('does not fall back when scoped result has exactly 3 listings', async () => {
    mockPrisma.fanListing.findMany.mockResolvedValue(makeRows(3, 50))

    const res = await app.inject({
      method: 'GET',
      url: '/v1/fan-sale/price-comps?eventId=evt-1&section=101',
      cookies: { at: makeToken() },
    })

    expect(res.statusCode).toBe(200)
    expect(mockPrisma.fanListing.findMany).toHaveBeenCalledTimes(1)
  })

  it('does not fall back when no section/row filter — event-level is already the scope', async () => {
    mockPrisma.fanListing.findMany.mockResolvedValue(makeRows(1, 50))

    const res = await app.inject({
      method: 'GET',
      url: '/v1/fan-sale/price-comps?eventId=evt-1',
      cookies: { at: makeToken() },
    })

    expect(res.statusCode).toBe(200)
    expect(mockPrisma.fanListing.findMany).toHaveBeenCalledTimes(1)
  })

  // -------------------------------------------------------------------------
  // Redis failure — graceful degradation
  // -------------------------------------------------------------------------

  it('still returns 200 if Redis setEx fails (fire-and-forget)', async () => {
    mockPrisma.fanListing.findMany.mockResolvedValue(makeRows(3, 50))
    mockRedis!.setEx.mockRejectedValue(new Error('Redis connection lost'))

    const res = await app.inject({
      method: 'GET',
      url: '/v1/fan-sale/price-comps?eventId=evt-1',
      cookies: { at: makeToken() },
    })

    expect(res.statusCode).toBe(200)  // cache failure must not fail the request
  })

  it('still returns 200 if redis is null (REDIS_URL not configured)', async () => {
    // Rebuild app without redis — null redis decorator
    jest.resetModules()

    const localPrisma = { ...mockPrisma, fanListing: { findMany: jest.fn().mockResolvedValue(makeRows(3, 50)) } }

    jest.doMock('../../../../plugins/prisma', () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fp = require('fastify-plugin')
      return {
        prismaPlugin: fp(async (f: { decorate: Function; addHook: Function }) => {
          f.decorate('prisma', localPrisma)
          f.addHook('onClose', jest.fn())
        }),
      }
    })

    jest.doMock('../../../../plugins/redis', () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fp = require('fastify-plugin')
      return {
        redisPlugin: fp(async (f: { decorate: Function }) => {
          f.decorate('redis', null)  // simulates REDIS_URL not set
        }),
      }
    })

    jest.doMock('../../../../services/hermes', () => ({
      HermesClient: jest.fn(() => ({ getOrder: jest.fn() })),
    }))

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildApp } = require('../../../../app')
    const localApp = await buildApp()

    const token = localApp.jwt.sign({ accountId: 42, refreshToken: 'r', tokenExpiresAt: 9_999_999_999, token: 't' })
    const res = await localApp.inject({
      method: 'GET',
      url: '/v1/fan-sale/price-comps?eventId=evt-1',
      cookies: { at: token },
    })

    expect(res.statusCode).toBe(200)
    await localApp.close()
  })

  // -------------------------------------------------------------------------
  // 400 — missing eventId
  // -------------------------------------------------------------------------

  it('400 — eventId is required', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/fan-sale/price-comps?section=101',
      cookies: { at: makeToken() },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).details.eventId).toBeDefined()
  })
})
