// MKPLS-358: update-listing tests
//
// Unit tests cover toNum and toListingResponse (lib/listing.ts).
// Integration tests exercise every AC status code via app.inject().

import { toNum } from './update-listing'
import { computeEstimatedPayout, toListingResponse } from '../../../../lib/listing'
import { FanListingStatus, TicketSource } from '../../../../types'

// ---------------------------------------------------------------------------
// Unit tests — no Fastify / DB
// ---------------------------------------------------------------------------

describe('toNum', () => {
  it('returns a plain number as-is', () => {
    expect(toNum(42.5)).toBe(42.5)
  })

  it('calls .toNumber() on a Decimal-like object', () => {
    expect(toNum({ toNumber: () => 99.99 })).toBe(99.99)
  })
})

describe('computeEstimatedPayout (lib/listing)', () => {
  it('applies 15% default fee', () => {
    expect(computeEstimatedPayout(100)).toBe(85)
  })

  it('uses the stored feePercent when provided', () => {
    expect(computeEstimatedPayout(200, 0.10)).toBe(180)
  })
})

describe('toListingResponse (lib/listing)', () => {
  const base = {
    id: 'lst-1',
    sellerId: 42,
    orderId: 'o1',
    ticketId: 't1',
    ticketSource: 'vivid_seats',
    eventId: 'evt-1',
    section: '101',
    row: 'C',
    seatNumber: '14',
    status: 'ACTIVE',
    createdAt: new Date('2026-06-01T00:00:00Z'),
    expiresAt: new Date('2026-09-01T00:00:00Z'),
  }

  it('maps plain-number prices and calculates estimatedPayout', () => {
    const result = toListingResponse({ ...base, askingPrice: 80, feePercent: 0.15 })
    expect(result.askingPrice).toBe(80)
    expect(result.estimatedPayout).toBe(68)
    expect(result.status).toBe(FanListingStatus.ACTIVE)
  })

  it('unwraps Decimal-like objects', () => {
    const result = toListingResponse({
      ...base,
      askingPrice: { toNumber: () => 60 },
      feePercent: { toNumber: () => 0.15 },
    })
    expect(result.askingPrice).toBe(60)
    expect(result.estimatedPayout).toBe(51)
  })

  it('normalises unknown ticketSource to OTHER', () => {
    const result = toListingResponse({ ...base, ticketSource: 'unknown', askingPrice: 50, feePercent: 0.15 })
    expect(result.ticketSource).toBe(TicketSource.OTHER)
  })
})

// ---------------------------------------------------------------------------
// Integration tests — full HTTP layer with mocked Prisma
// ---------------------------------------------------------------------------

describe('PATCH /v1/fan-sale/listings/:id', () => {
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
      fanListing: {
        findFirst: jest.fn(),
        update: jest.fn(),
      },
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

    // This handler does not call Hermes — mock it as a no-op to avoid env errors
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
      askingPrice: 50,       // plain number — simulates Decimal.toNumber() path
      feePercent: 0.15,
      status: 'ACTIVE',
      createdAt: new Date('2026-06-01T00:00:00Z'),
      expiresAt: new Date('2026-09-01T00:00:00Z'),
      ...overrides,
    }
  }

  const url = '/v1/fan-sale/listings/lst-1'
  const validPayload = { askingPrice: 45 }

  // -------------------------------------------------------------------------
  // 200 — happy path
  // -------------------------------------------------------------------------

  it('200 — updates price, recalculates estimatedPayout, writes audit log', async () => {
    const existing = makeListing({ askingPrice: 50 })
    const afterUpdate = makeListing({ askingPrice: 45 })

    mockPrisma.fanListing.findFirst.mockResolvedValue(existing)
    mockPrisma.fanListing.update.mockResolvedValue(afterUpdate)

    const res = await app.inject({
      method: 'PATCH',
      url,
      cookies: { at: makeToken() },
      payload: validPayload,
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.askingPrice).toBe(45)
    expect(body.estimatedPayout).toBe(38.25)   // 45 × 0.85

    // Audit log written with old and new price
    expect(mockPrisma.listingAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'price_updated',
          actorId: 42,
          metadata: { oldPrice: 50, newPrice: 45 },
        }),
      }),
    )
  })

  it('200 — feePercent stored on listing is used for payout calc, not default', async () => {
    const existing = makeListing({ askingPrice: 100 })
    const afterUpdate = makeListing({ askingPrice: 100, feePercent: 0.10 })

    mockPrisma.fanListing.findFirst.mockResolvedValue(existing)
    mockPrisma.fanListing.update.mockResolvedValue(afterUpdate)

    const res = await app.inject({
      method: 'PATCH',
      url,
      cookies: { at: makeToken() },
      payload: { askingPrice: 100 },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).estimatedPayout).toBe(90)  // 100 × 0.90 (10% fee)
  })

  // -------------------------------------------------------------------------
  // 400 — validation errors
  // -------------------------------------------------------------------------

  it('400 — askingPrice below $1.00', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url,
      cookies: { at: makeToken() },
      payload: { askingPrice: 0.50 },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).details.askingPrice).toBeDefined()
  })

  it('400 — askingPrice is zero', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url,
      cookies: { at: makeToken() },
      payload: { askingPrice: 0 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('400 — askingPrice exceeds $10,000', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url,
      cookies: { at: makeToken() },
      payload: { askingPrice: 10_001 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('400 — askingPrice is not a number', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url,
      cookies: { at: makeToken() },
      payload: { askingPrice: 'fifty' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('400 — missing askingPrice', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url,
      cookies: { at: makeToken() },
      payload: {},
    })
    expect(res.statusCode).toBe(400)
  })

  // -------------------------------------------------------------------------
  // 404 — not found or not owned (same response intentionally)
  // -------------------------------------------------------------------------

  it('404 — listing does not exist', async () => {
    mockPrisma.fanListing.findFirst.mockResolvedValue(null)

    const res = await app.inject({
      method: 'PATCH',
      url,
      cookies: { at: makeToken() },
      payload: validPayload,
    })
    expect(res.statusCode).toBe(404)
  })

  it('404 — listing belongs to a different seller (ownership leak prevention)', async () => {
    // findFirst with { sellerId: 42 } returns null when listing is owned by seller 99
    mockPrisma.fanListing.findFirst.mockResolvedValue(null)

    const res = await app.inject({
      method: 'PATCH',
      url,
      cookies: { at: makeToken(42) },  // token for seller 42, listing owned by 99
      payload: validPayload,
    })
    expect(res.statusCode).toBe(404)   // 403 would leak existence
  })

  // -------------------------------------------------------------------------
  // 422 — listing not ACTIVE
  // -------------------------------------------------------------------------

  it.each(['SOLD', 'DELISTED', 'EXPIRED', 'FULFILLED'] as const)(
    '422 — cannot reprice a listing in status %s',
    async (status) => {
      mockPrisma.fanListing.findFirst.mockResolvedValue(makeListing({ status }))

      const res = await app.inject({
        method: 'PATCH',
        url,
        cookies: { at: makeToken() },
        payload: validPayload,
      })
      expect(res.statusCode).toBe(422)
      expect(JSON.parse(res.body).message).toMatch(status)
    },
  )
})
