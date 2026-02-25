// MKPLS-363: fulfill handler integration tests

import fp from 'fastify-plugin'
import { FastifyInstance } from 'fastify'

// ---------------------------------------------------------------------------
// Shared mock state
// ---------------------------------------------------------------------------

const mockFanListingFindFirst = jest.fn()
const mockFanListingUpdate = jest.fn()
const mockFulfillmentFindFirst = jest.fn()
const mockFulfillmentUpdate = jest.fn()
const mockListingAuditLogCreate = jest.fn()
const mockTransaction = jest
  .fn()
  .mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops))

const mockPrisma = {
  fanListing: {
    findFirst: mockFanListingFindFirst,
    update: mockFanListingUpdate,
  },
  fulfillment: {
    findFirst: mockFulfillmentFindFirst,
    update: mockFulfillmentUpdate,
  },
  listingAuditLog: {
    create: mockListingAuditLogCreate,
  },
  $transaction: mockTransaction,
}

const mockSendTicketTransferred = jest.fn().mockResolvedValue(undefined)

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const SELLER_ID = 42
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
    status: 'SOLD',
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: EXPIRES,
    ...overrides,
  }
}

function makeFulfillment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'fulfillment-001',
    listingId: 'listing-001',
    buyerOrderId: 'buyer-order-001',
    status: 'PENDING',
    deadlineAt: new Date('2026-08-14T18:00:00Z'),
    fulfilledAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

describe('POST /v1/fan-sale/listings/:id/fulfill', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    jest.doMock('../../../../plugins/prisma', () =>
      fp(async (fastify: FastifyInstance) => {
        fastify.decorate('prisma', mockPrisma)
      }),
    )

    jest.doMock('../../../../services/notifications', () => ({
      StubNotificationService: jest.fn().mockImplementation(() => ({
        sendKycVerified: jest.fn(),
        sendKycFailed: jest.fn(),
        sendTicketTransferred: mockSendTicketTransferred,
      })),
    }))

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
    mockFanListingFindFirst.mockResolvedValue(makeListing())
    mockFulfillmentFindFirst.mockResolvedValue(makeFulfillment())
    mockFanListingUpdate.mockResolvedValue(makeListing({ status: 'FULFILLED' }))
    mockFulfillmentUpdate.mockResolvedValue({})
    mockListingAuditLogCreate.mockResolvedValue({})
  })

  const inject = (listingId = 'listing-001', sellerId = SELLER_ID) => {
    const token = app.jwt.sign({ accountId: sellerId })
    return app.inject({
      method: 'POST',
      url: `/v1/fan-sale/listings/${listingId}/fulfill`,
      headers: { authorization: `Bearer ${token}` },
    })
  }

  // -------------------------------------------------------------------------
  // 200 — success
  // -------------------------------------------------------------------------

  it('returns 200 with the updated listing on success', async () => {
    const res = await inject()
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.id).toBe('listing-001')
    expect(body.status).toBe('FULFILLED')
  })

  it('runs all three DB writes atomically in a single $transaction', async () => {
    await inject()
    expect(mockTransaction).toHaveBeenCalledTimes(1)
    expect(mockFanListingUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'FULFILLED' } }),
    )
    expect(mockFulfillmentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'fulfillment-001' },
        data: expect.objectContaining({ status: 'FULFILLED', fulfilledAt: expect.any(Date) }),
      }),
    )
    expect(mockListingAuditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'fulfilled', actorId: SELLER_ID }),
      }),
    )
  })

  it('calls sendTicketTransferred with the buyerOrderId (fire-and-forget)', async () => {
    await inject()
    await Promise.resolve()
    expect(mockSendTicketTransferred).toHaveBeenCalledWith('buyer-order-001')
  })

  it('returns 200 and completes even when notification throws', async () => {
    mockSendTicketTransferred.mockRejectedValue(new Error('Braze down'))
    const res = await inject()
    expect(res.statusCode).toBe(200)
    expect(mockTransaction).toHaveBeenCalledTimes(1)
  })

  // -------------------------------------------------------------------------
  // 404
  // -------------------------------------------------------------------------

  it('returns 404 when listing does not exist', async () => {
    mockFanListingFindFirst.mockResolvedValue(null)
    const res = await inject('nonexistent')
    expect(res.statusCode).toBe(404)
    expect(mockTransaction).not.toHaveBeenCalled()
  })

  it('returns 404 (not 403) when listing belongs to a different seller', async () => {
    mockFanListingFindFirst.mockResolvedValue(null) // findFirst with wrong sellerId returns null
    const res = await inject('listing-001', 999)
    expect(res.statusCode).toBe(404)
  })

  // -------------------------------------------------------------------------
  // 422 — wrong status
  // -------------------------------------------------------------------------

  it.each([['ACTIVE'], ['DELISTED'], ['EXPIRED'], ['FULFILLED']])(
    'returns 422 when listing status is %s',
    async (status) => {
      mockFanListingFindFirst.mockResolvedValue(makeListing({ status }))
      const res = await inject()
      expect(res.statusCode).toBe(422)
      expect(JSON.parse(res.body).message).toContain(status)
      expect(mockTransaction).not.toHaveBeenCalled()
    },
  )

  it('returns 422 when no PENDING fulfillment record exists', async () => {
    mockFulfillmentFindFirst.mockResolvedValue(null)
    const res = await inject()
    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body).message).toContain('fulfillment')
    expect(mockTransaction).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // 401
  // -------------------------------------------------------------------------

  it('returns 401 without JWT', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/fan-sale/listings/listing-001/fulfill',
    })
    expect(res.statusCode).toBe(401)
  })
})
