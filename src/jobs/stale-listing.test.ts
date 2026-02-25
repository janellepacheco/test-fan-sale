// MKPLS-356: stale listing cron unit tests

import { runStaleListingCron, StaleListingDeps } from './stale-listing'
import { NotificationService } from '../services/notifications'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFindMany = jest.fn()
const mockPrisma = {
  fanListing: { findMany: mockFindMany },
}

const mockNotify = {
  sendListingSold: jest.fn().mockResolvedValue(undefined),
  sendFulfillmentReminder: jest.fn(),
  sendTicketTransferred: jest.fn(),
  sendPayoutSent: jest.fn(),
  sendFulfillmentFailed: jest.fn(),
  sendKycOutcome: jest.fn(),
} as unknown as NotificationService

const mockRedis = {
  zadd: jest.fn().mockResolvedValue(1),
  zremrangebyscore: jest.fn().mockResolvedValue(0),
  zcard: jest.fn().mockResolvedValue(0), // 0 = not yet notified
  expire: jest.fn().mockResolvedValue(1),
}

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }

function makeDeps(overrides: Partial<StaleListingDeps> = {}): StaleListingDeps {
  return {
    prisma: mockPrisma as never,
    notificationService: mockNotify,
    redis: mockRedis,
    logger: mockLogger,
    staleThresholdMs: 0,    // 0 = all active listings qualify as stale
    priceThresholdRatio: 1.20,
    dedupWindowMs: 60_000,
    ...overrides,
  }
}

const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

function makeListing(price: number, id = 'fl-001', eventId = 'ev-1', section = 'A') {
  return {
    id,
    sellerId: 1,
    eventId,
    section,
    row: '1',
    seatNumber: '5',
    askingPrice: { toNumber: () => price },
    expiresAt: FUTURE,
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks()
  mockRedis.zcard.mockResolvedValue(0)
})

// ---------------------------------------------------------------------------
// Basic flow
// ---------------------------------------------------------------------------

describe('stale listing cron — basic flow', () => {
  it('returns scanned=0 and sends no notifications when no stale listings', async () => {
    mockFindMany.mockResolvedValue([])
    const result = await runStaleListingCron(makeDeps())
    expect(result.scanned).toBe(0)
    expect(result.notified).toBe(0)
    expect(mockNotify.sendListingSold).not.toHaveBeenCalled()
  })

  it('notifies seller when price > 120% of median', async () => {
    // Stale listing at $180, median is $100 → 180% > 120%
    mockFindMany
      .mockResolvedValueOnce([makeListing(180)]) // stale listings query
      .mockResolvedValueOnce([            // median query for ev-1::A
        { askingPrice: { toNumber: () => 90 } },
        { askingPrice: { toNumber: () => 100 } },
        { askingPrice: { toNumber: () => 110 } },
      ])
    const result = await runStaleListingCron(makeDeps())
    expect(result.overpriced).toBe(1)
    expect(result.notified).toBe(1)
    expect(mockNotify.sendListingSold).toHaveBeenCalledTimes(1)
  })

  it('does not notify when price is at or below 120% of median', async () => {
    // Listing at $115, median $100 → 115% < 120%
    mockFindMany
      .mockResolvedValueOnce([makeListing(115)])
      .mockResolvedValueOnce([{ askingPrice: { toNumber: () => 100 } }])
    const result = await runStaleListingCron(makeDeps())
    expect(result.overpriced).toBe(0)
    expect(result.notified).toBe(0)
  })

  it('does not notify when price is exactly at the threshold', async () => {
    mockFindMany
      .mockResolvedValueOnce([makeListing(120)])
      .mockResolvedValueOnce([{ askingPrice: { toNumber: () => 100 } }])
    const result = await runStaleListingCron(makeDeps())
    expect(result.notified).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Median calculation
// ---------------------------------------------------------------------------

describe('stale listing cron — median calculation', () => {
  it('uses median of odd-count list correctly', async () => {
    // [80, 100, 200] → median 100; listing at $125 → 125% > 120%
    mockFindMany
      .mockResolvedValueOnce([makeListing(125)])
      .mockResolvedValueOnce([
        { askingPrice: { toNumber: () => 80 } },
        { askingPrice: { toNumber: () => 100 } },
        { askingPrice: { toNumber: () => 200 } },
      ])
    const result = await runStaleListingCron(makeDeps())
    expect(result.notified).toBe(1)
  })

  it('uses average of two middle values for even-count list', async () => {
    // [80, 100, 120, 200] → median (100+120)/2 = 110; threshold 132; listing at $130 ≤ 132
    mockFindMany
      .mockResolvedValueOnce([makeListing(130)])
      .mockResolvedValueOnce([
        { askingPrice: { toNumber: () => 80 } },
        { askingPrice: { toNumber: () => 100 } },
        { askingPrice: { toNumber: () => 120 } },
        { askingPrice: { toNumber: () => 200 } },
      ])
    const result = await runStaleListingCron(makeDeps())
    expect(result.notified).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

describe('stale listing cron — deduplication', () => {
  it('skips notification if listing was already notified (Redis key present)', async () => {
    mockRedis.zcard.mockResolvedValue(1) // already notified
    mockFindMany
      .mockResolvedValueOnce([makeListing(200)])
      .mockResolvedValueOnce([{ askingPrice: { toNumber: () => 100 } }])
    const result = await runStaleListingCron(makeDeps())
    expect(result.deduped).toBe(1)
    expect(result.notified).toBe(0)
  })

  it('records dedup key with correct TTL after notifying', async () => {
    mockFindMany
      .mockResolvedValueOnce([makeListing(200)])
      .mockResolvedValueOnce([{ askingPrice: { toNumber: () => 100 } }])
    await runStaleListingCron(makeDeps({ dedupWindowMs: 60_000 }))
    expect(mockRedis.zadd).toHaveBeenCalledWith(
      'stale_reprice:fl-001',
      expect.any(Number),
      expect.any(String),
    )
    expect(mockRedis.expire).toHaveBeenCalledWith('stale_reprice:fl-001', 60)
  })
})

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('stale listing cron — error handling', () => {
  it('logs error and continues when notification throws', async () => {
    ;(mockNotify.sendListingSold as jest.Mock).mockRejectedValueOnce(new Error('Hermes down'))
    mockFindMany
      .mockResolvedValueOnce([makeListing(200, 'fl-001'), makeListing(200, 'fl-002')])
      .mockResolvedValue([{ askingPrice: { toNumber: () => 100 } }])
    const result = await runStaleListingCron(makeDeps())
    expect(mockLogger.error).toHaveBeenCalled()
    // fl-002 should still be attempted
    expect(mockNotify.sendListingSold).toHaveBeenCalledTimes(2)
  })

  it('skips group when no prices in median query', async () => {
    mockFindMany
      .mockResolvedValueOnce([makeListing(200)])
      .mockResolvedValueOnce([]) // no prices
    const result = await runStaleListingCron(makeDeps())
    expect(result.notified).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('stale listing cron — idempotency', () => {
  it('is safe to run multiple times — dedup prevents duplicate notifications', async () => {
    mockFindMany
      .mockResolvedValue([makeListing(200)])
      mockFindMany
      .mockResolvedValueOnce([makeListing(200)])
      .mockResolvedValueOnce([{ askingPrice: { toNumber: () => 100 } }])
      .mockResolvedValueOnce([makeListing(200)])
      .mockResolvedValueOnce([{ askingPrice: { toNumber: () => 100 } }])

    await runStaleListingCron(makeDeps())
    // Second run: Redis reports already notified
    mockRedis.zcard.mockResolvedValue(1)
    const second = await runStaleListingCron(makeDeps())
    expect(second.deduped).toBe(1)
    expect(second.notified).toBe(0)
  })
})
