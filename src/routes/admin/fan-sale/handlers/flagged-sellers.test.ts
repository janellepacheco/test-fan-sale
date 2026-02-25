// MKPLS-389: flagged sellers handler unit tests

import { flaggedSellersHandler } from './flagged-sellers'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGroupBy = jest.fn()
const mockFlagFindMany = jest.fn()
const mockAccountFindMany = jest.fn()
const mockListingGroupBy = jest.fn()

const mockPrisma = {
  sellerFlag: {
    groupBy: mockGroupBy,
    findMany: mockFlagFindMany,
  },
  sellerPaymentAccount: {
    findMany: mockAccountFindMany,
  },
  fanListing: {
    groupBy: mockListingGroupBy,
  },
}

const mockReply = {
  code: jest.fn().mockReturnThis(),
  send: jest.fn().mockReturnThis(),
}

function makeRequest(query: Record<string, string> = {}) {
  return {
    query,
    server: { prisma: mockPrisma },
    user: { accountId: 99 },
  }
}

// Default mock data
const defaultFlagGroups = [
  { sellerId: 1, _count: { id: 3 } },
  { sellerId: 2, _count: { id: 1 } },
]
const defaultFlagDetails = [
  { sellerId: 1, reason: 'fulfillment_failure', createdAt: new Date() },
  { sellerId: 1, reason: 'fulfillment_failure', createdAt: new Date() },
  { sellerId: 1, reason: 'seller_suspended', createdAt: new Date() },
  { sellerId: 2, reason: 'fulfillment_failure', createdAt: new Date() },
]
const defaultAccounts = [
  { sellerId: 1, fanSaleSuspended: true, kycStatus: 'KYC_VERIFIED' },
  { sellerId: 2, fanSaleSuspended: false, kycStatus: 'KYC_VERIFIED' },
]
const defaultListingCounts = [
  { sellerId: 1, _count: { id: 2 } },
]

beforeEach(() => {
  jest.clearAllMocks()
  mockGroupBy
    .mockResolvedValueOnce(defaultFlagGroups)  // first call: paginated groups
    .mockResolvedValueOnce(defaultFlagGroups)  // second call: total count
  mockFlagFindMany.mockResolvedValue(defaultFlagDetails)
  mockAccountFindMany.mockResolvedValue(defaultAccounts)
  mockListingGroupBy.mockResolvedValue(defaultListingCounts)
})

async function invoke(query: Record<string, string> = {}) {
  return flaggedSellersHandler(makeRequest(query) as never, mockReply as never)
}

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

describe('flagged sellers — response shape', () => {
  it('returns sellers array with total, page, and limit', async () => {
    await invoke()
    expect(mockReply.code).toHaveBeenCalledWith(200)
    const sent = mockReply.send.mock.calls[0][0]
    expect(Array.isArray(sent.sellers)).toBe(true)
    expect(typeof sent.total).toBe('number')
    expect(sent.page).toBe(1)
    expect(sent.limit).toBe(25)
  })

  it('each seller entry has required fields', async () => {
    await invoke()
    const seller = mockReply.send.mock.calls[0][0].sellers[0]
    expect(typeof seller.sellerId).toBe('number')
    expect(typeof seller.flagCount).toBe('number')
    expect(Array.isArray(seller.flagReasons)).toBe(true)
    expect(typeof seller.activeListingCount).toBe('number')
    expect(typeof seller.fanSaleSuspended).toBe('boolean')
  })

  it('deduplicates flag reasons', async () => {
    await invoke()
    const seller = mockReply.send.mock.calls[0][0].sellers[0]
    // seller 1 has 2x fulfillment_failure + 1x seller_suspended → deduplicated
    expect(seller.flagReasons).toHaveLength(2)
    expect(seller.flagReasons).toContain('fulfillment_failure')
    expect(seller.flagReasons).toContain('seller_suspended')
  })

  it('reflects suspension status from SellerPaymentAccount', async () => {
    await invoke()
    const sellers = mockReply.send.mock.calls[0][0].sellers
    const suspended = sellers.find((s: { sellerId: number }) => s.sellerId === 1)
    const notSuspended = sellers.find((s: { sellerId: number }) => s.sellerId === 2)
    expect(suspended.fanSaleSuspended).toBe(true)
    expect(notSuspended.fanSaleSuspended).toBe(false)
  })

  it('reports activeListingCount=0 for sellers with no active listings', async () => {
    await invoke()
    const sellers = mockReply.send.mock.calls[0][0].sellers
    const s2 = sellers.find((s: { sellerId: number }) => s.sellerId === 2)
    expect(s2.activeListingCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Empty result
// ---------------------------------------------------------------------------

describe('flagged sellers — empty result', () => {
  it('returns empty sellers array when no flags exist', async () => {
    mockGroupBy.mockReset().mockResolvedValue([])
    await invoke()
    const sent = mockReply.send.mock.calls[0][0]
    expect(sent.sellers).toEqual([])
    expect(sent.total).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Filtering by userId
// ---------------------------------------------------------------------------

describe('flagged sellers — userId filter', () => {
  it('passes userId filter to groupBy query', async () => {
    await invoke({ userId: '42' })
    const firstCall = mockGroupBy.mock.calls[0][0]
    expect(firstCall.where?.sellerId).toBe(42)
  })

  it('returns 400 for non-numeric userId', async () => {
    await invoke({ userId: 'bad' })
    expect(mockReply.code).toHaveBeenCalledWith(400)
  })
})

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

describe('flagged sellers — pagination', () => {
  it('applies page and limit to groupBy query', async () => {
    await invoke({ page: '2', limit: '10' })
    const firstCall = mockGroupBy.mock.calls[0][0]
    expect(firstCall.skip).toBe(10)
    expect(firstCall.take).toBe(10)
  })

  it('returns 400 when limit exceeds 100', async () => {
    await invoke({ limit: '101' })
    expect(mockReply.code).toHaveBeenCalledWith(400)
  })

  it('defaults to page=1 and limit=25', async () => {
    await invoke()
    const firstCall = mockGroupBy.mock.calls[0][0]
    expect(firstCall.skip).toBe(0)
    expect(firstCall.take).toBe(25)
  })
})
