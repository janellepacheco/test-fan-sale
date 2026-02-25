// MKPLS-371: payout-release cron unit tests

import { runPayoutReleaseCron, PayoutReleaseDeps } from './payout-release'

// ---------------------------------------------------------------------------
// Shared mocks
// ---------------------------------------------------------------------------

const mockFanListingFindMany = jest.fn()
const mockSellerPaymentAccountFindUnique = jest.fn()
const mockPayoutCreate = jest.fn()

const mockPrisma = {
  fanListing: { findMany: mockFanListingFindMany },
  sellerPaymentAccount: { findUnique: mockSellerPaymentAccountFindUnique },
  payout: { create: mockPayoutCreate },
}

const mockReleasePayout = jest.fn()
const mockPayoutService = { releasePayout: mockReleasePayout }

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EVENT_DATE_PAST = new Date(Date.now() - 50 * 60 * 60 * 1000) // 50h ago

function makeListing(overrides: Record<string, unknown> = {}) {
  return {
    id: 'listing-001',
    sellerId: 42,
    askingPrice: { toNumber: () => 100.0 },
    status: 'FULFILLED',
    eventDate: EVENT_DATE_PAST,
    ...overrides,
  }
}

function makeSpa(overrides: Record<string, unknown> = {}) {
  return {
    sellerId: 42,
    adyenBalanceAccountId: 'ba-001',
    paymentInstrumentId: 'pi-001',
    kycStatus: 'KYC_VERIFIED',
    ...overrides,
  }
}

function makeDeps(overrides: Partial<PayoutReleaseDeps> = {}): PayoutReleaseDeps {
  return {
    prisma: mockPrisma as unknown as PayoutReleaseDeps['prisma'],
    payoutService: mockPayoutService as unknown as PayoutReleaseDeps['payoutService'],
    logger: mockLogger,
    holdWindowMs: 48 * 60 * 60 * 1000,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks()
  mockFanListingFindMany.mockResolvedValue([makeListing()])
  mockSellerPaymentAccountFindUnique.mockResolvedValue(makeSpa())
  mockReleasePayout.mockResolvedValue({ transferId: 'tr-001', status: 'initiated' })
  mockPayoutCreate.mockResolvedValue({})
})

// ---------------------------------------------------------------------------
// Query correctness
// ---------------------------------------------------------------------------

describe('runPayoutReleaseCron — query', () => {
  it('queries for FULFILLED listings past the 48h cutoff with no active payout', async () => {
    await runPayoutReleaseCron(makeDeps())
    expect(mockFanListingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'FULFILLED',
          eventDate: expect.objectContaining({ lte: expect.any(Date) }),
          payouts: { none: { status: { in: ['INITIATED', 'COMPLETED'] } } },
        }),
      }),
    )
  })

  it('passes a cutoff approximately 48h in the past', async () => {
    const before = Date.now()
    await runPayoutReleaseCron(makeDeps())
    const after = Date.now()
    const cutoff: Date = mockFanListingFindMany.mock.calls[0][0].where.eventDate.lte
    const expectedMs = 48 * 60 * 60 * 1000
    expect(before - cutoff.getTime()).toBeGreaterThanOrEqual(expectedMs - 50)
    expect(after - cutoff.getTime()).toBeLessThanOrEqual(expectedMs + 50)
  })
})

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('runPayoutReleaseCron — success', () => {
  it('calls releasePayout with correct params for a 15% fee', async () => {
    await runPayoutReleaseCron(makeDeps())
    expect(mockReleasePayout).toHaveBeenCalledWith({
      balanceAccountId: 'ba-001',
      paymentInstrumentId: 'pi-001',
      amountValue: 8500, // $100 * 0.85 * 100 cents = 8500
      amountCurrency: 'USD',
      reference: 'listing-001',
    })
  })

  it('writes a payout record with INITIATED status and the Adyen transferId', async () => {
    await runPayoutReleaseCron(makeDeps())
    expect(mockPayoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sellerId: 42,
          listingId: 'listing-001',
          transferId: 'tr-001',
          status: 'INITIATED',
          initiatedAt: expect.any(Date),
        }),
      }),
    )
  })

  it('returns summary with initiated=1 for a single successful listing', async () => {
    const summary = await runPayoutReleaseCron(makeDeps())
    expect(summary).toEqual({ eligible: 1, initiated: 1, skipped: 0, failed: 0 })
  })

  it('processes multiple listings independently', async () => {
    mockFanListingFindMany.mockResolvedValue([
      makeListing({ id: 'l-001' }),
      makeListing({ id: 'l-002', sellerId: 99 }),
    ])
    mockSellerPaymentAccountFindUnique.mockResolvedValue(makeSpa())
    mockReleasePayout
      .mockResolvedValueOnce({ transferId: 'tr-001', status: 'initiated' })
      .mockResolvedValueOnce({ transferId: 'tr-002', status: 'initiated' })

    const summary = await runPayoutReleaseCron(makeDeps())
    expect(mockReleasePayout).toHaveBeenCalledTimes(2)
    expect(mockPayoutCreate).toHaveBeenCalledTimes(2)
    expect(summary.initiated).toBe(2)
  })

  it('uses a custom feePercent when provided', async () => {
    await runPayoutReleaseCron(makeDeps({ feePercent: 0.10 }))
    // $100 * 0.90 * 100 = 9000 cents
    expect(mockReleasePayout).toHaveBeenCalledWith(
      expect.objectContaining({ amountValue: 9000 }),
    )
  })
})

// ---------------------------------------------------------------------------
// Skip — seller not eligible
// ---------------------------------------------------------------------------

describe('runPayoutReleaseCron — skipped listings', () => {
  it('skips seller with no payment account', async () => {
    mockSellerPaymentAccountFindUnique.mockResolvedValue(null)
    const summary = await runPayoutReleaseCron(makeDeps())
    expect(mockReleasePayout).not.toHaveBeenCalled()
    expect(summary.skipped).toBe(1)
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ listingId: 'listing-001' }),
      expect.any(String),
    )
  })

  it('skips seller with missing balanceAccountId', async () => {
    mockSellerPaymentAccountFindUnique.mockResolvedValue(
      makeSpa({ adyenBalanceAccountId: null }),
    )
    const summary = await runPayoutReleaseCron(makeDeps())
    expect(mockReleasePayout).not.toHaveBeenCalled()
    expect(summary.skipped).toBe(1)
  })

  it('skips seller with missing paymentInstrumentId', async () => {
    mockSellerPaymentAccountFindUnique.mockResolvedValue(
      makeSpa({ paymentInstrumentId: null }),
    )
    const summary = await runPayoutReleaseCron(makeDeps())
    expect(mockReleasePayout).not.toHaveBeenCalled()
    expect(summary.skipped).toBe(1)
  })

  it('skips seller whose KYC is not verified (PENDING)', async () => {
    mockSellerPaymentAccountFindUnique.mockResolvedValue(
      makeSpa({ kycStatus: 'PENDING' }),
    )
    const summary = await runPayoutReleaseCron(makeDeps())
    expect(mockReleasePayout).not.toHaveBeenCalled()
    expect(summary.skipped).toBe(1)
  })

  it('skips seller whose KYC is FAILED', async () => {
    mockSellerPaymentAccountFindUnique.mockResolvedValue(
      makeSpa({ kycStatus: 'KYC_FAILED' }),
    )
    const summary = await runPayoutReleaseCron(makeDeps())
    expect(mockReleasePayout).not.toHaveBeenCalled()
    expect(summary.skipped).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

describe('runPayoutReleaseCron — payout failure', () => {
  it('increments failed count and logs PAYOUT_FAILED_MAX_RETRIES when service throws', async () => {
    mockReleasePayout.mockRejectedValue(new Error('releasePayout failed: 503'))
    const summary = await runPayoutReleaseCron(makeDeps())
    expect(summary.failed).toBe(1)
    expect(summary.initiated).toBe(0)
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'PAYOUT_FAILED_MAX_RETRIES', listingId: 'listing-001' }),
      expect.any(String),
    )
  })

  it('does not write a payout record when releasePayout throws', async () => {
    mockReleasePayout.mockRejectedValue(new Error('network error'))
    await runPayoutReleaseCron(makeDeps())
    expect(mockPayoutCreate).not.toHaveBeenCalled()
  })

  it('continues processing remaining listings after one failure', async () => {
    mockFanListingFindMany.mockResolvedValue([
      makeListing({ id: 'l-001' }),
      makeListing({ id: 'l-002' }),
    ])
    mockReleasePayout
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce({ transferId: 'tr-002', status: 'initiated' })

    const summary = await runPayoutReleaseCron(makeDeps())
    expect(summary.failed).toBe(1)
    expect(summary.initiated).toBe(1)
    expect(mockPayoutCreate).toHaveBeenCalledTimes(1)
  })

  it('returns summary with all zeros when no listings are found', async () => {
    mockFanListingFindMany.mockResolvedValue([])
    const summary = await runPayoutReleaseCron(makeDeps())
    expect(summary).toEqual({ eligible: 0, initiated: 0, skipped: 0, failed: 0 })
    expect(mockReleasePayout).not.toHaveBeenCalled()
  })
})
