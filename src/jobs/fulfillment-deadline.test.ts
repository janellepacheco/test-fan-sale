// MKPLS-364: fulfillment-deadline cron unit tests

import { runFulfillmentDeadlineCron, FulfillmentDeadlineDeps } from './fulfillment-deadline'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFulfillmentFindMany = jest.fn()
const mockFulfillmentUpdate = jest.fn()
const mockFanListingUpdate = jest.fn()
const mockSellerFlagCreate = jest.fn()
const mockSellerFlagCount = jest.fn()
const mockSellerPaymentAccountUpsert = jest.fn()
const mockTransaction = jest
  .fn()
  .mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops))

const mockPrisma = {
  fulfillment: { findMany: mockFulfillmentFindMany, update: mockFulfillmentUpdate },
  fanListing: { update: mockFanListingUpdate },
  sellerFlag: { create: mockSellerFlagCreate, count: mockSellerFlagCount },
  sellerPaymentAccount: { upsert: mockSellerPaymentAccountUpsert },
  $transaction: mockTransaction,
}

const mockInitiateRefund = jest.fn().mockResolvedValue({ refundId: 'refund-001' })
const mockRefundService = { initiateRefund: mockInitiateRefund }

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PAST = new Date(Date.now() - 60_000)

function makeFulfillment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'fulfillment-001',
    listingId: 'listing-001',
    buyerOrderId: 'buyer-order-001',
    status: 'PENDING',
    deadlineAt: PAST,
    listing: {
      id: 'listing-001',
      sellerId: 42,
      status: 'SOLD',
      askingPrice: { toNumber: () => 100.0 },
    },
    ...overrides,
  }
}

function makeDeps(overrides: Partial<FulfillmentDeadlineDeps> = {}): FulfillmentDeadlineDeps {
  return {
    prisma: mockPrisma as unknown as FulfillmentDeadlineDeps['prisma'],
    refundService: mockRefundService,
    logger: mockLogger,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks()
  mockFulfillmentFindMany.mockResolvedValue([makeFulfillment()])
  mockFulfillmentUpdate.mockResolvedValue({})
  mockFanListingUpdate.mockResolvedValue({})
  mockSellerFlagCreate.mockResolvedValue({})
  mockSellerFlagCount.mockResolvedValue(1) // below suspension threshold by default
  mockSellerPaymentAccountUpsert.mockResolvedValue({})
})

// ---------------------------------------------------------------------------
// Query correctness
// ---------------------------------------------------------------------------

describe('runFulfillmentDeadlineCron — query', () => {
  it('queries for PENDING fulfillments with deadlineAt <= now', async () => {
    await runFulfillmentDeadlineCron(makeDeps())
    expect(mockFulfillmentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'PENDING', deadlineAt: { lte: expect.any(Date) } },
        include: { listing: true },
      }),
    )
  })

  it('returns zero summary with no DB calls when no overdue fulfillments', async () => {
    mockFulfillmentFindMany.mockResolvedValue([])
    const summary = await runFulfillmentDeadlineCron(makeDeps())
    expect(summary).toEqual({ overdue: 0, processed: 0, failed: 0, suspended: 0 })
    expect(mockTransaction).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Atomic writes
// ---------------------------------------------------------------------------

describe('runFulfillmentDeadlineCron — atomic DB writes', () => {
  it('runs all three writes in a single $transaction', async () => {
    await runFulfillmentDeadlineCron(makeDeps())
    expect(mockTransaction).toHaveBeenCalledTimes(1)
  })

  it('marks fulfillment as FAILED', async () => {
    await runFulfillmentDeadlineCron(makeDeps())
    expect(mockFulfillmentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'fulfillment-001' },
        data: { status: 'FAILED' },
      }),
    )
  })

  it('marks the listing as DELISTED', async () => {
    await runFulfillmentDeadlineCron(makeDeps())
    expect(mockFanListingUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'listing-001' },
        data: { status: 'DELISTED' },
      }),
    )
  })

  it('inserts a seller flag with reason fulfillment_failure', async () => {
    await runFulfillmentDeadlineCron(makeDeps())
    expect(mockSellerFlagCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sellerId: 42,
          reason: 'fulfillment_failure',
          fulfillmentId: 'fulfillment-001',
        }),
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// Refund
// ---------------------------------------------------------------------------

describe('runFulfillmentDeadlineCron — buyer refund', () => {
  it('calls initiateRefund with correct params', async () => {
    await runFulfillmentDeadlineCron(makeDeps())
    expect(mockInitiateRefund).toHaveBeenCalledWith({
      buyerOrderId: 'buyer-order-001',
      amountValue: 10000, // $100 * 100 cents
      amountCurrency: 'USD',
      reference: 'fulfillment-001',
    })
  })

  it('logs an error but does not fail the fulfillment when refund throws', async () => {
    mockInitiateRefund.mockRejectedValue(new Error('Adyen down'))
    const summary = await runFulfillmentDeadlineCron(makeDeps())
    // processed still increments — refund failure doesn't abort the job
    expect(summary.processed).toBe(1)
    expect(summary.failed).toBe(0)
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ fulfillmentId: 'fulfillment-001' }),
      expect.stringContaining('refund failed'),
    )
  })
})

// ---------------------------------------------------------------------------
// Seller suspension
// ---------------------------------------------------------------------------

describe('runFulfillmentDeadlineCron — seller suspension', () => {
  it('does NOT suspend when flag count is 1', async () => {
    mockSellerFlagCount.mockResolvedValue(1)
    await runFulfillmentDeadlineCron(makeDeps())
    expect(mockSellerPaymentAccountUpsert).not.toHaveBeenCalled()
  })

  it('suspends seller when flag count reaches 2', async () => {
    mockSellerFlagCount.mockResolvedValue(2)
    const summary = await runFulfillmentDeadlineCron(makeDeps())
    expect(mockSellerPaymentAccountUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sellerId: 42 },
        update: { fanSaleSuspended: true },
      }),
    )
    expect(summary.suspended).toBe(1)
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sellerId: 42, flagCount: 2 }),
      expect.any(String),
    )
  })

  it('suspends seller when flag count is greater than 2', async () => {
    mockSellerFlagCount.mockResolvedValue(5)
    const summary = await runFulfillmentDeadlineCron(makeDeps())
    expect(mockSellerPaymentAccountUpsert).toHaveBeenCalled()
    expect(summary.suspended).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Summary and failure handling
// ---------------------------------------------------------------------------

describe('runFulfillmentDeadlineCron — summary and errors', () => {
  it('returns correct summary for a single successful fulfillment', async () => {
    const summary = await runFulfillmentDeadlineCron(makeDeps())
    expect(summary).toEqual({ overdue: 1, processed: 1, failed: 0, suspended: 0 })
  })

  it('increments failed and continues when $transaction throws', async () => {
    mockTransaction.mockRejectedValueOnce(new Error('DB error'))
    mockFulfillmentFindMany.mockResolvedValue([
      makeFulfillment({ id: 'f-001' }),
      makeFulfillment({ id: 'f-002' }),
    ])
    // Second transaction succeeds
    mockTransaction.mockImplementationOnce((ops: Promise<unknown>[]) => Promise.all(ops))

    const summary = await runFulfillmentDeadlineCron(makeDeps())
    expect(summary.failed).toBe(1)
    expect(summary.processed).toBe(1)
  })

  it('logs FULFILLMENT_DEADLINE_FAILURE_THRESHOLD when failures exceed threshold', async () => {
    // 3 overdue fulfillments, all fail
    mockFulfillmentFindMany.mockResolvedValue([
      makeFulfillment({ id: 'f-001' }),
      makeFulfillment({ id: 'f-002' }),
      makeFulfillment({ id: 'f-003' }),
    ])
    mockTransaction.mockRejectedValue(new Error('DB error'))

    await runFulfillmentDeadlineCron(makeDeps({ alertThreshold: 2 }))

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'FULFILLMENT_DEADLINE_FAILURE_THRESHOLD' }),
      expect.any(String),
    )
  })

  it('does NOT log threshold alert when failures are at or below threshold', async () => {
    mockFulfillmentFindMany.mockResolvedValue([
      makeFulfillment({ id: 'f-001' }),
      makeFulfillment({ id: 'f-002' }),
    ])
    mockTransaction.mockRejectedValue(new Error('DB error'))

    await runFulfillmentDeadlineCron(makeDeps({ alertThreshold: 10 }))

    const thresholdCall = mockLogger.error.mock.calls.find((c) =>
      c[0]?.event === 'FULFILLMENT_DEADLINE_FAILURE_THRESHOLD',
    )
    expect(thresholdCall).toBeUndefined()
  })

  it('is idempotent — re-running only processes PENDING fulfillments', async () => {
    // First run processes them; second run returns empty list
    mockFulfillmentFindMany
      .mockResolvedValueOnce([makeFulfillment()])
      .mockResolvedValueOnce([])

    await runFulfillmentDeadlineCron(makeDeps())
    const summary2 = await runFulfillmentDeadlineCron(makeDeps())

    expect(summary2).toEqual({ overdue: 0, processed: 0, failed: 0, suspended: 0 })
    expect(mockTransaction).toHaveBeenCalledTimes(1) // only on first run
  })
})
