// MKPLS-359: delist tests
// Integration tests cover every AC status code via app.inject().

describe('DELETE /v1/fan-sale/listings/:id', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any
  let mockPrisma: {
    $connect: jest.Mock
    $disconnect: jest.Mock
    $transaction: jest.Mock
    fanListing: { findFirst: jest.Mock; update: jest.Mock }
    listingAuditLog: { create: jest.Mock }
  }

  beforeAll(async () => {
    jest.resetModules()

    mockPrisma = {
      $connect: jest.fn().mockResolvedValue(undefined),
      $disconnect: jest.fn().mockResolvedValue(undefined),
      $transaction: jest.fn(),
      fanListing: { findFirst: jest.fn(), update: jest.fn() },
      listingAuditLog: { create: jest.fn() },
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
    mockPrisma.$transaction.mockImplementation(async (cb: (p: typeof mockPrisma) => unknown) =>
      cb(mockPrisma),
    )
    mockPrisma.fanListing.findFirst.mockResolvedValue(null)
    mockPrisma.listingAuditLog.create.mockResolvedValue({})
  })

  function makeToken(accountId = 42) {
    return app.jwt.sign({ accountId, refreshToken: 'r', tokenExpiresAt: 9_999_999_999, token: 't' })
  }

  function makeListing(overrides = {}) {
    return {
      id: 'lst-1',
      sellerId: 42,
      orderId: 'o1',
      ticketId: 't1',
      ticketSource: 'vivid_seats',
      eventId: 'evt-1',
      section: '101',
      row: 'C',
      seatNumber: '14',
      askingPrice: 50,
      feePercent: 0.15,
      status: 'ACTIVE',
      createdAt: new Date('2026-06-01T00:00:00Z'),
      expiresAt: new Date('2026-09-01T00:00:00Z'),
      ...overrides,
    }
  }

  const url = '/v1/fan-sale/listings/lst-1'

  // -------------------------------------------------------------------------
  // 200 — happy path
  // -------------------------------------------------------------------------

  it('200 — sets status to DELISTED and returns updated listing', async () => {
    mockPrisma.fanListing.findFirst.mockResolvedValue(makeListing())
    mockPrisma.fanListing.update.mockResolvedValue(makeListing({ status: 'DELISTED' }))

    const res = await app.inject({
      method: 'DELETE',
      url,
      cookies: { at: makeToken() },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).status).toBe('DELISTED')

    // Audit log written with action = 'delisted'
    expect(mockPrisma.listingAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'delisted',
          actorId: 42,
          listingId: 'lst-1',
        }),
      }),
    )
  })

  it('200 — update is called with status DELISTED', async () => {
    mockPrisma.fanListing.findFirst.mockResolvedValue(makeListing())
    mockPrisma.fanListing.update.mockResolvedValue(makeListing({ status: 'DELISTED' }))

    await app.inject({ method: 'DELETE', url, cookies: { at: makeToken() } })

    expect(mockPrisma.fanListing.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'DELISTED' } }),
    )
  })

  // -------------------------------------------------------------------------
  // 404 — not found or not owned
  // -------------------------------------------------------------------------

  it('404 — listing does not exist', async () => {
    mockPrisma.fanListing.findFirst.mockResolvedValue(null)

    const res = await app.inject({ method: 'DELETE', url, cookies: { at: makeToken() } })
    expect(res.statusCode).toBe(404)
  })

  it('404 — listing belongs to a different seller (same response as not found)', async () => {
    // findFirst scoped to sellerId=42 returns null when listing is owned by seller 99
    mockPrisma.fanListing.findFirst.mockResolvedValue(null)

    const res = await app.inject({ method: 'DELETE', url, cookies: { at: makeToken(42) } })
    expect(res.statusCode).toBe(404)
  })

  // -------------------------------------------------------------------------
  // 422 — non-delistable statuses
  // -------------------------------------------------------------------------

  it.each(['SOLD', 'EXPIRED', 'FULFILLED', 'DELISTED'] as const)(
    '422 — cannot delist a listing in status %s',
    async (status) => {
      mockPrisma.fanListing.findFirst.mockResolvedValue(makeListing({ status }))

      const res = await app.inject({ method: 'DELETE', url, cookies: { at: makeToken() } })
      expect(res.statusCode).toBe(422)
      expect(JSON.parse(res.body).message).toMatch(status)
    },
  )

  it('does not write an audit log when delist is rejected', async () => {
    mockPrisma.fanListing.findFirst.mockResolvedValue(makeListing({ status: 'SOLD' }))

    await app.inject({ method: 'DELETE', url, cookies: { at: makeToken() } })

    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
    expect(mockPrisma.listingAuditLog.create).not.toHaveBeenCalled()
  })
})
