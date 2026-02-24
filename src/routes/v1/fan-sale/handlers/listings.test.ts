// MKPLS-357: listings handler integration tests

import fp from 'fastify-plugin'
import { FastifyInstance } from 'fastify'

// ---------------------------------------------------------------------------
// Shared mock state
// ---------------------------------------------------------------------------

const mockFanListingFindMany = jest.fn()
const mockFanListingCount = jest.fn()
const mockFanListingFindFirst = jest.fn()
const mockTransaction = jest
  .fn()
  .mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops))

const mockPrisma = {
  fanListing: {
    findMany: mockFanListingFindMany,
    count: mockFanListingCount,
    findFirst: mockFanListingFindFirst,
  },
  $transaction: mockTransaction,
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const SELLER_ID = 55
const NOW = new Date('2026-06-01T12:00:00Z')
const EXPIRES = new Date('2026-08-15T18:00:00Z')

function makeListing(overrides: Record<string, unknown> = {}) {
  return {
    id: 'listing-001',
    sellerId: SELLER_ID,
    orderId: 'order-001',
    ticketId: 'ticket-001',
    ticketSource: 'vivid_seats',
    eventId: 'event-001',
    section: 'A',
    row: '1',
    seatNumber: '5',
    askingPrice: { toNumber: () => 75.0 },
    feePercent: { toNumber: () => 0.15 },
    status: 'ACTIVE',
    barcodeHash: null,
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: EXPIRES,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

describe('GET /v1/fan-sale/listings', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    jest.doMock('../../../../plugins/prisma', () =>
      fp(async (fastify: FastifyInstance) => {
        fastify.decorate('prisma', mockPrisma)
      }),
    )

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildApp } = require('../../../../app')
    app = await buildApp()
  })

  afterAll(async () => {
    await app.close()
    jest.resetModules()
  })

  beforeEach(() => {
    jest.clearAllMocks()
  })

  const injectList = (query = '', sellerId = SELLER_ID) => {
    const token = app.jwt.sign({ accountId: sellerId })
    return app.inject({
      method: 'GET',
      url: `/v1/fan-sale/listings${query}`,
      headers: { authorization: `Bearer ${token}` },
    })
  }

  // -------------------------------------------------------------------------
  // 200 — happy path
  // -------------------------------------------------------------------------

  it('returns 200 with listings array and pagination metadata', async () => {
    mockTransaction.mockResolvedValueOnce([[makeListing()], 1])

    const res = await injectList()
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.listings).toHaveLength(1)
    expect(body.total).toBe(1)
    expect(body.page).toBe(1)
    expect(body.limit).toBe(20)
  })

  it('returns empty listings array (not 404) when seller has no listings', async () => {
    mockTransaction.mockResolvedValueOnce([[], 0])

    const res = await injectList()
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.listings).toEqual([])
    expect(body.total).toBe(0)
  })

  it('maps Decimal fields to numbers and computes estimatedPayout', async () => {
    mockTransaction.mockResolvedValueOnce([[makeListing()], 1])

    const res = await injectList()
    const { listings } = JSON.parse(res.body)
    expect(listings[0].askingPrice).toBe(75)
    expect(listings[0].estimatedPayout).toBe(63.75) // 75 * 0.85
  })

  it('passes status filter to Prisma when provided', async () => {
    mockTransaction.mockResolvedValueOnce([[], 0])

    await injectList('?status=active')

    const [[findManyCall]] = mockTransaction.mock.calls
    // The $transaction receives [findMany promise, count promise]; we check the
    // where clause via the mockFanListingFindMany call
    expect(mockFanListingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sellerId: SELLER_ID, status: 'ACTIVE' } }),
    )
  })

  it('accepts case-insensitive status filter', async () => {
    mockTransaction.mockResolvedValueOnce([[], 0])
    await injectList('?status=sold')
    expect(mockFanListingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sellerId: SELLER_ID, status: 'SOLD' } }),
    )
  })

  it('paginates correctly — skips (page-1)*limit rows', async () => {
    mockTransaction.mockResolvedValueOnce([[], 0])
    await injectList('?page=3&limit=10')
    expect(mockFanListingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 20, take: 10 }),
    )
  })

  it('returns 400 for an invalid status value', async () => {
    const res = await injectList('?status=banana')
    expect(res.statusCode).toBe(400)
    expect(mockTransaction).not.toHaveBeenCalled()
  })

  it('returns 400 when limit exceeds 100', async () => {
    const res = await injectList('?limit=200')
    expect(res.statusCode).toBe(400)
  })

  it('returns 401 without JWT', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/fan-sale/listings' })
    expect(res.statusCode).toBe(401)
  })

  it('only returns listings belonging to the authenticated seller', async () => {
    mockTransaction.mockResolvedValueOnce([[], 0])
    await injectList('', 99)
    expect(mockFanListingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ sellerId: 99 }) }),
    )
  })
})

// ---------------------------------------------------------------------------
// GET /v1/fan-sale/listings/:id
// ---------------------------------------------------------------------------

describe('GET /v1/fan-sale/listings/:id', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    jest.doMock('../../../../plugins/prisma', () =>
      fp(async (fastify: FastifyInstance) => {
        fastify.decorate('prisma', mockPrisma)
      }),
    )

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildApp } = require('../../../../app')
    app = await buildApp()
  })

  afterAll(async () => {
    await app.close()
    jest.resetModules()
  })

  beforeEach(() => jest.clearAllMocks())

  const injectGet = (id: string, sellerId = SELLER_ID) => {
    const token = app.jwt.sign({ accountId: sellerId })
    return app.inject({
      method: 'GET',
      url: `/v1/fan-sale/listings/${id}`,
      headers: { authorization: `Bearer ${token}` },
    })
  }

  it('returns 200 with the listing when found and owned by seller', async () => {
    mockFanListingFindFirst.mockResolvedValue(makeListing())

    const res = await injectGet('listing-001')
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.id).toBe('listing-001')
    expect(body.askingPrice).toBe(75)
    expect(body.estimatedPayout).toBe(63.75)
  })

  it('queries with both id and sellerId to prevent existence leak', async () => {
    mockFanListingFindFirst.mockResolvedValue(makeListing())
    await injectGet('listing-001', SELLER_ID)
    expect(mockFanListingFindFirst).toHaveBeenCalledWith({
      where: { id: 'listing-001', sellerId: SELLER_ID },
    })
  })

  it('returns 404 when listing does not exist', async () => {
    mockFanListingFindFirst.mockResolvedValue(null)
    const res = await injectGet('nonexistent')
    expect(res.statusCode).toBe(404)
  })

  it('returns 404 (not 403) when listing exists but is owned by a different seller', async () => {
    // findFirst returns null because sellerId doesn't match — same 404 as missing
    mockFanListingFindFirst.mockResolvedValue(null)
    const res = await injectGet('listing-001', 999)
    expect(res.statusCode).toBe(404)
  })

  it('returns 401 without JWT', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/fan-sale/listings/listing-001' })
    expect(res.statusCode).toBe(401)
  })
})
