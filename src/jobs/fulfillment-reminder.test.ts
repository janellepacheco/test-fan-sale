// MKPLS-367 + MKPLS-381: fulfillment reminder cron unit tests

import { runFulfillmentReminderCron, FulfillmentReminderDeps } from './fulfillment-reminder'
import { NotificationService } from '../services/notifications'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFindMany = jest.fn()
const mockPrisma = { fulfillment: { findMany: mockFindMany } }

const mockNotify = {
  sendFulfillmentReminder: jest.fn().mockResolvedValue(undefined),
  sendListingSold: jest.fn(),
  sendTicketTransferred: jest.fn(),
  sendPayoutSent: jest.fn(),
  sendFulfillmentFailed: jest.fn(),
  sendKycOutcome: jest.fn(),
} as unknown as NotificationService

const mockRedis = {
  zadd: jest.fn().mockResolvedValue(1),
  zremrangebyscore: jest.fn().mockResolvedValue(0),
  zcard: jest.fn().mockResolvedValue(0),
  expire: jest.fn().mockResolvedValue(1),
}

const mockLogger = { info: jest.fn(), error: jest.fn() }

// Use a very small window so any deadline within ±5ms qualifies
function makeDeps(overrides: Partial<FulfillmentReminderDeps> = {}): FulfillmentReminderDeps {
  return {
    prisma: mockPrisma as never,
    notificationService: mockNotify,
    redis: mockRedis,
    logger: mockLogger,
    reminderLeadMs: 4 * 60 * 60 * 1000,
    windowHalfMs: 15 * 60 * 1000,
    ...overrides,
  }
}

function makeFulfillment(id = 'ful-001', deadlineOffset = 4 * 60 * 60 * 1000) {
  return {
    id,
    status: 'PENDING',
    deadlineAt: new Date(Date.now() + deadlineOffset),
    listing: {
      sellerId: 10,
      eventId: 'ev-001',
      section: 'A',
      row: '1',
      seatNumber: '5',
    },
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockRedis.zcard.mockResolvedValue(0)
  mockFindMany.mockResolvedValue([])
})

// ---------------------------------------------------------------------------
// Basic flow
// ---------------------------------------------------------------------------

describe('fulfillment reminder cron — basic flow', () => {
  it('returns scanned=0 and sends nothing when no pending fulfillments in window', async () => {
    const result = await runFulfillmentReminderCron(makeDeps())
    expect(result.scanned).toBe(0)
    expect(result.reminded).toBe(0)
    expect(mockNotify.sendFulfillmentReminder).not.toHaveBeenCalled()
  })

  it('sends reminder for each qualifying PENDING fulfillment', async () => {
    mockFindMany.mockResolvedValue([makeFulfillment('ful-001'), makeFulfillment('ful-002')])
    const result = await runFulfillmentReminderCron(makeDeps())
    expect(result.scanned).toBe(2)
    expect(result.reminded).toBe(2)
    expect(mockNotify.sendFulfillmentReminder).toHaveBeenCalledTimes(2)
  })

  it('queries with correct window bounds', async () => {
    const lead = 4 * 60 * 60 * 1000
    const half = 15 * 60 * 1000
    await runFulfillmentReminderCron(makeDeps({ reminderLeadMs: lead, windowHalfMs: half }))
    const where = mockFindMany.mock.calls[0][0].where
    expect(where.deadlineAt.gte.getTime()).toBeGreaterThan(Date.now() + lead - half - 200)
    expect(where.deadlineAt.lte.getTime()).toBeLessThan(Date.now() + lead + half + 200)
    expect(where.status).toBe('PENDING')
  })
})

// ---------------------------------------------------------------------------
// Notification content
// ---------------------------------------------------------------------------

describe('fulfillment reminder cron — notification content', () => {
  it('passes sellerId, fulfillmentId, deadline, and deep link to notification service', async () => {
    const deadline = new Date(Date.now() + 4 * 60 * 60 * 1000)
    mockFindMany.mockResolvedValue([{ ...makeFulfillment(), deadlineAt: deadline }])
    await runFulfillmentReminderCron(makeDeps())
    expect(mockNotify.sendFulfillmentReminder).toHaveBeenCalledWith(
      expect.objectContaining({
        sellerId: 10,
        fulfillmentId: 'ful-001',
        deadline,
        fulfillmentDeepLink: '/fan-sale/fulfillments/ful-001',
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

describe('fulfillment reminder cron — deduplication', () => {
  it('skips fulfillment if reminder was already sent (Redis key present)', async () => {
    mockRedis.zcard.mockResolvedValue(1)
    mockFindMany.mockResolvedValue([makeFulfillment()])
    const result = await runFulfillmentReminderCron(makeDeps())
    expect(result.deduped).toBe(1)
    expect(result.reminded).toBe(0)
    expect(mockNotify.sendFulfillmentReminder).not.toHaveBeenCalled()
  })

  it('records dedup key with 7-day TTL after sending reminder', async () => {
    mockFindMany.mockResolvedValue([makeFulfillment()])
    await runFulfillmentReminderCron(makeDeps())
    expect(mockRedis.zadd).toHaveBeenCalledWith(
      'fulfillment_reminder_sent:ful-001',
      expect.any(Number),
      expect.any(String),
    )
    expect(mockRedis.expire).toHaveBeenCalledWith(
      'fulfillment_reminder_sent:ful-001',
      7 * 24 * 60 * 60,
    )
  })
})

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('fulfillment reminder cron — error handling', () => {
  it('logs error and increments failed count when notification throws', async () => {
    ;(mockNotify.sendFulfillmentReminder as jest.Mock).mockRejectedValueOnce(
      new Error('Hermes down'),
    )
    mockFindMany.mockResolvedValue([makeFulfillment()])
    const result = await runFulfillmentReminderCron(makeDeps())
    expect(result.failed).toBe(1)
    expect(result.reminded).toBe(0)
    expect(mockLogger.error).toHaveBeenCalled()
  })

  it('continues processing remaining fulfillments after one failure', async () => {
    ;(mockNotify.sendFulfillmentReminder as jest.Mock)
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce(undefined)
    mockFindMany.mockResolvedValue([makeFulfillment('ful-001'), makeFulfillment('ful-002')])
    const result = await runFulfillmentReminderCron(makeDeps())
    expect(result.failed).toBe(1)
    expect(result.reminded).toBe(1)
  })
})
