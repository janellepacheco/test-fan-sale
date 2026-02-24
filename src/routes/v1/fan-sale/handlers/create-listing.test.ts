// MKPLS-347: create-listing tests
//
// Unit tests cover pure helpers (no I/O, injectable `now`).
// Integration tests spin up a real Fastify instance with mocked Prisma + Hermes
// and cover every status code from the acceptance criteria.

import {
  computeBarcodeHash,
  computeExpiresAt,
  computeEstimatedPayout,
  getIneligibilityReason,
  toListingResponse,
  FEE_PERCENT,
} from './create-listing'
import { HermesOrder, HermesTicket } from '../../../../services/hermes'
import { FanListingStatus, TicketSource } from '../../../../types'

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const TOMORROW = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
const IN_30_MIN = new Date(Date.now() + 30 * 60 * 1000).toISOString()

function makeTicket(overrides: Partial<HermesTicket> = {}): HermesTicket {
  return {
    ticketId: 't1',
    seatNumber: '14',
    section: '101',
    row: 'C',
    eventId: 'evt-1',
    eventName: 'The Eras Tour',
    eventDate: TOMORROW,
    ticketSource: 'vivid_seats',
    scanned: false,
    used: false,
    ...overrides,
  }
}

function makeOrder(overrides: Partial<HermesOrder> = {}): HermesOrder {
  return {
    orderId: 'o1',
    accountId: 42,
    status: 'confirmed',
    hasActiveDispute: false,
    sellerSuspended: false,
    tickets: [makeTicket()],
    ...overrides,
  }
}

const EMPTY = new Set<string>()

// ---------------------------------------------------------------------------
// computeBarcodeHash
// ---------------------------------------------------------------------------

describe('computeBarcodeHash', () => {
  it('returns a 64-char lowercase hex string', () => {
    expect(computeBarcodeHash('ticket-abc')).toMatch(/^[a-f0-9]{64}$/)
  })

  it('is deterministic for the same input', () => {
    expect(computeBarcodeHash('ticket-abc')).toBe(computeBarcodeHash('ticket-abc'))
  })

  it('produces different hashes for different ticketIds', () => {
    expect(computeBarcodeHash('ticket-1')).not.toBe(computeBarcodeHash('ticket-2'))
  })
})

// ---------------------------------------------------------------------------
// computeExpiresAt
// ---------------------------------------------------------------------------

describe('computeExpiresAt', () => {
  const now = new Date('2026-06-01T12:00:00Z')

  it('returns event start − 2 hours for an event within the 90-day cap', () => {
    const result = computeExpiresAt('2026-06-10T20:00:00Z', now)
    expect(result.toISOString()).toBe('2026-06-10T18:00:00.000Z')
  })

  it('caps at now + 90 days for far-future events', () => {
    const result = computeExpiresAt('2030-01-01T00:00:00Z', now)
    const expected = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000)
    expect(result.getTime()).toBe(expected.getTime())
  })
})

// ---------------------------------------------------------------------------
// computeEstimatedPayout
// ---------------------------------------------------------------------------

describe('computeEstimatedPayout', () => {
  it('applies the default 15% fee', () => {
    expect(computeEstimatedPayout(100)).toBe(85)
  })

  it('rounds to 2 decimal places', () => {
    // 49.99 × 0.85 = 42.4915 → 42.49
    expect(computeEstimatedPayout(49.99)).toBe(42.49)
  })

  it('accepts a custom fee percent', () => {
    expect(computeEstimatedPayout(100, 0.10)).toBe(90)
  })

  it('FEE_PERCENT constant is 0.15', () => {
    expect(FEE_PERCENT).toBe(0.15)
  })
})

// ---------------------------------------------------------------------------
// getIneligibilityReason
// ---------------------------------------------------------------------------

describe('getIneligibilityReason', () => {
  const now = new Date('2026-06-01T12:00:00Z')
  const THREE_HOURS = 3 * 60 * 60 * 1000

  function future(ms: number) {
    return new Date(now.getTime() + ms).toISOString()
  }

  it('returns null when all rules pass', () => {
    expect(
      getIneligibilityReason(makeOrder(), makeTicket({ eventDate: future(THREE_HOURS) }), EMPTY, now),
    ).toBeNull()
  })

  it('catches non-confirmed order status', () => {
    expect(
      getIneligibilityReason(makeOrder({ status: 'cancelled' }), makeTicket(), EMPTY, now),
    ).toMatch(/not confirmed/)
  })

  it('catches active dispute', () => {
    expect(
      getIneligibilityReason(makeOrder({ hasActiveDispute: true }), makeTicket(), EMPTY, now),
    ).toMatch(/dispute/)
  })

  it('catches suspended seller', () => {
    expect(
      getIneligibilityReason(makeOrder({ sellerSuspended: true }), makeTicket(), EMPTY, now),
    ).toMatch(/suspended/)
  })

  it('catches scanned ticket', () => {
    const ticket = makeTicket({ scanned: true, eventDate: future(THREE_HOURS) })
    expect(getIneligibilityReason(makeOrder(), ticket, EMPTY, now)).toMatch(/scanned/)
  })

  it('catches used ticket', () => {
    const ticket = makeTicket({ used: true, eventDate: future(THREE_HOURS) })
    expect(getIneligibilityReason(makeOrder(), ticket, EMPTY, now)).toMatch(/used/)
  })

  it('catches event within 2 hours', () => {
    const ticket = makeTicket({ eventDate: future(60 * 60 * 1000) }) // 1 hour
    expect(getIneligibilityReason(makeOrder(), ticket, EMPTY, now)).toMatch(/less than 2 hours/)
  })

  it('catches ticket that is already actively listed', () => {
    const ticket = makeTicket({ eventDate: future(THREE_HOURS) })
    expect(getIneligibilityReason(makeOrder(), ticket, new Set(['t1']), now)).toMatch(
      /already has an active listing/,
    )
  })

  it('returns the first failing reason (order-level before ticket-level)', () => {
    const order = makeOrder({ status: 'cancelled', hasActiveDispute: true })
    const reason = getIneligibilityReason(order, makeTicket(), EMPTY, now)
    expect(reason).toMatch(/not confirmed/)  // order-level wins
  })
})

// ---------------------------------------------------------------------------
// toListingResponse
// ---------------------------------------------------------------------------

describe('toListingResponse', () => {
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

  it('maps a plain-number listing correctly', () => {
    const result = toListingResponse({ ...base, askingPrice: 50, feePercent: FEE_PERCENT })
    expect(result.askingPrice).toBe(50)
    expect(result.estimatedPayout).toBe(42.5)
    expect(result.status).toBe(FanListingStatus.ACTIVE)
    expect(result.createdAt).toBe('2026-06-01T00:00:00.000Z')
  })

  it('calls .toNumber() on Prisma Decimal objects', () => {
    const decimalLike = (val: number) => ({ toNumber: () => val })
    const result = toListingResponse({
      ...base,
      askingPrice: decimalLike(75),
      feePercent: decimalLike(0.15),
    })
    expect(result.askingPrice).toBe(75)
    expect(result.estimatedPayout).toBe(63.75)
  })

  it.each([
    ['vivid_seats', TicketSource.VIVID_SEATS],
    ['stubhub',     TicketSource.STUBHUB],
    ['axs',         TicketSource.AXS],
    ['venue_direct', TicketSource.OTHER], // unknown → OTHER
  ])('normalises ticketSource "%s" to %s', (raw, expected) => {
    const result = toListingResponse({ ...base, ticketSource: raw, askingPrice: 50, feePercent: 0.15 })
    expect(result.ticketSource).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
// Integration tests — full HTTP layer with mocked Prisma and Hermes
//
// Mocking strategy:
//   - jest.doMock (not hoisted) is called inside beforeAll after local variables
//     are defined, so closures capture the real mock objects.
//   - buildApp is require()'d dynamically after mocks are in place.
//   - jest.resetModules() ensures a clean module registry between describe blocks.
// ---------------------------------------------------------------------------

describe('POST /v1/fan-sale/listings', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any
  let mockGetOrder: jest.Mock
  let mockPrisma: {
    $connect: jest.Mock
    $disconnect: jest.Mock
    $transaction: jest.Mock
    fanListing: { count: jest.Mock; findFirst: jest.Mock; create: jest.Mock; findMany: jest.Mock }
    listingAuditLog: { create: jest.Mock }
  }

  beforeAll(async () => {
    jest.resetModules()

    mockGetOrder = jest.fn()
    mockPrisma = {
      $connect: jest.fn().mockResolvedValue(undefined),
      $disconnect: jest.fn().mockResolvedValue(undefined),
      $transaction: jest.fn(),
      fanListing: {
        count: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        findMany: jest.fn(),
      },
      listingAuditLog: { create: jest.fn() },
    }

    // Mock HermesClient — captured via closure so getOrder is controllable per-test
    jest.doMock('../../../../services/hermes', () => ({
      HermesClient: jest.fn(() => ({ getOrder: mockGetOrder })),
    }))

    // Mock prismaPlugin — use fp() so the decorator leaks to all sibling scopes
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

    // Dynamic require — sees the mocked modules above
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
    // Re-establish defaults cleared by clearAllMocks
    mockPrisma.$transaction.mockImplementation(async (cb: (p: typeof mockPrisma) => unknown) =>
      cb(mockPrisma),
    )
    mockPrisma.fanListing.count.mockResolvedValue(0)
    mockPrisma.fanListing.findFirst.mockResolvedValue(null)
    mockPrisma.fanListing.findMany.mockResolvedValue([])
  })

  // Helper: sign a real JWT so authenticate middleware passes
  function makeToken(accountId: number) {
    return app.jwt.sign({
      accountId,
      refreshToken: 'r',
      tokenExpiresAt: 9_999_999_999,
      token: 't',
    })
  }

  function makeHermesOrder(overrides: Partial<HermesOrder> = {}): HermesOrder {
    return {
      orderId: 'o1',
      accountId: 42,
      status: 'confirmed',
      hasActiveDispute: false,
      sellerSuspended: false,
      tickets: [
        {
          ticketId: 't1',
          seatNumber: '14',
          section: '101',
          row: 'C',
          eventId: 'evt-1',
          eventName: 'The Eras Tour',
          eventDate: TOMORROW,
          ticketSource: 'vivid_seats',
          scanned: false,
          used: false,
        },
      ],
      ...overrides,
    }
  }

  function makeCreatedListing() {
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
      feePercent: FEE_PERCENT,
      status: 'ACTIVE',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    }
  }

  const validPayload = { orderId: 'o1', ticketId: 't1', askingPrice: 50 }

  // -------------------------------------------------------------------------
  // 201 — happy path
  // -------------------------------------------------------------------------

  it('201 — creates listing, returns ListingResponse, writes audit log', async () => {
    mockGetOrder.mockResolvedValue(makeHermesOrder())
    const created = makeCreatedListing()
    mockPrisma.fanListing.create.mockResolvedValue(created)
    mockPrisma.listingAuditLog.create.mockResolvedValue({})

    const res = await app.inject({
      method: 'POST',
      url: '/v1/fan-sale/listings',
      cookies: { at: makeToken(42) },
      payload: validPayload,
    })

    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.id).toBe('lst-1')
    expect(body.askingPrice).toBe(50)
    expect(body.estimatedPayout).toBe(42.5)      // 50 × 0.85
    expect(body.status).toBe('ACTIVE')
    expect(body.ticketSource).toBe(TicketSource.VIVID_SEATS)

    // Audit log written inside the transaction
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)
    expect(mockPrisma.listingAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'created', actorId: 42 }),
      }),
    )
  })

  it('201 — cross-platform StubHub ticket is accepted', async () => {
    const order = makeHermesOrder()
    order.tickets[0].ticketSource = 'stubhub'
    mockGetOrder.mockResolvedValue(order)
    const created = { ...makeCreatedListing(), ticketSource: 'stubhub' }
    mockPrisma.fanListing.create.mockResolvedValue(created)
    mockPrisma.listingAuditLog.create.mockResolvedValue({})

    const res = await app.inject({
      method: 'POST',
      url: '/v1/fan-sale/listings',
      cookies: { at: makeToken(42) },
      payload: validPayload,
    })

    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body).ticketSource).toBe(TicketSource.STUBHUB)
  })

  // -------------------------------------------------------------------------
  // 400 — validation errors
  // -------------------------------------------------------------------------

  it('400 — missing orderId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/fan-sale/listings',
      cookies: { at: makeToken(42) },
      payload: { ticketId: 't1', askingPrice: 50 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('400 — askingPrice is negative', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/fan-sale/listings',
      cookies: { at: makeToken(42) },
      payload: { orderId: 'o1', ticketId: 't1', askingPrice: -1 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('400 — askingPrice exceeds $10,000', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/fan-sale/listings',
      cookies: { at: makeToken(42) },
      payload: { orderId: 'o1', ticketId: 't1', askingPrice: 10_001 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('400 — askingPrice is a string', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/fan-sale/listings',
      cookies: { at: makeToken(42) },
      payload: { orderId: 'o1', ticketId: 't1', askingPrice: 'fifty' },
    })
    expect(res.statusCode).toBe(400)
  })

  // -------------------------------------------------------------------------
  // 403 — ownership
  // -------------------------------------------------------------------------

  it('403 — order belongs to a different account', async () => {
    mockGetOrder.mockResolvedValue(makeHermesOrder({ accountId: 99 }))

    const res = await app.inject({
      method: 'POST',
      url: '/v1/fan-sale/listings',
      cookies: { at: makeToken(42) },
      payload: validPayload,
    })
    expect(res.statusCode).toBe(403)
  })

  // -------------------------------------------------------------------------
  // 404 — order not found
  // -------------------------------------------------------------------------

  it('404 — Hermes returns null for the order', async () => {
    mockGetOrder.mockResolvedValue(null)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/fan-sale/listings',
      cookies: { at: makeToken(42) },
      payload: validPayload,
    })
    expect(res.statusCode).toBe(404)
  })

  // -------------------------------------------------------------------------
  // 409 — barcode already active
  // -------------------------------------------------------------------------

  it('409 — barcode hash already exists as an active listing', async () => {
    mockGetOrder.mockResolvedValue(makeHermesOrder())
    mockPrisma.fanListing.findFirst.mockResolvedValue({ id: 'existing-lst' })

    const res = await app.inject({
      method: 'POST',
      url: '/v1/fan-sale/listings',
      cookies: { at: makeToken(42) },
      payload: validPayload,
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).message).toMatch(/already listed/)
  })

  // -------------------------------------------------------------------------
  // 422 — eligibility failures
  // -------------------------------------------------------------------------

  it('422 — ticketId not found in the order', async () => {
    mockGetOrder.mockResolvedValue(makeHermesOrder())

    const res = await app.inject({
      method: 'POST',
      url: '/v1/fan-sale/listings',
      cookies: { at: makeToken(42) },
      payload: { orderId: 'o1', ticketId: 'does-not-exist', askingPrice: 50 },
    })
    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body).message).toMatch(/not found in order/)
  })

  it('422 — order status is not confirmed', async () => {
    mockGetOrder.mockResolvedValue(makeHermesOrder({ status: 'cancelled' }))

    const res = await app.inject({
      method: 'POST',
      url: '/v1/fan-sale/listings',
      cookies: { at: makeToken(42) },
      payload: validPayload,
    })
    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body).message).toMatch(/not confirmed/)
  })

  it('422 — order has an active dispute', async () => {
    mockGetOrder.mockResolvedValue(makeHermesOrder({ hasActiveDispute: true }))

    const res = await app.inject({
      method: 'POST',
      url: '/v1/fan-sale/listings',
      cookies: { at: makeToken(42) },
      payload: validPayload,
    })
    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body).message).toMatch(/dispute/)
  })

  it('422 — seller account is suspended', async () => {
    mockGetOrder.mockResolvedValue(makeHermesOrder({ sellerSuspended: true }))

    const res = await app.inject({
      method: 'POST',
      url: '/v1/fan-sale/listings',
      cookies: { at: makeToken(42) },
      payload: validPayload,
    })
    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body).message).toMatch(/suspended/)
  })

  it('422 — ticket has been scanned', async () => {
    const order = makeHermesOrder()
    order.tickets[0].scanned = true
    mockGetOrder.mockResolvedValue(order)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/fan-sale/listings',
      cookies: { at: makeToken(42) },
      payload: validPayload,
    })
    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body).message).toMatch(/scanned/)
  })

  it('422 — event starts in less than 2 hours', async () => {
    const order = makeHermesOrder()
    order.tickets[0].eventDate = IN_30_MIN
    mockGetOrder.mockResolvedValue(order)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/fan-sale/listings',
      cookies: { at: makeToken(42) },
      payload: validPayload,
    })
    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body).message).toMatch(/less than 2 hours/)
  })

  it('422 — ticket already has an active listing (DB dedup via findMany)', async () => {
    mockGetOrder.mockResolvedValue(makeHermesOrder())
    // findMany returns the ticket as already listed
    mockPrisma.fanListing.findMany.mockResolvedValue([{ ticketId: 't1' }])

    const res = await app.inject({
      method: 'POST',
      url: '/v1/fan-sale/listings',
      cookies: { at: makeToken(42) },
      payload: validPayload,
    })
    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body).message).toMatch(/already has an active listing/)
  })

  // -------------------------------------------------------------------------
  // 429 — velocity cap
  // -------------------------------------------------------------------------

  it('429 — seller already has 10 active listings', async () => {
    mockGetOrder.mockResolvedValue(makeHermesOrder())
    mockPrisma.fanListing.count.mockResolvedValue(10)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/fan-sale/listings',
      cookies: { at: makeToken(42) },
      payload: validPayload,
    })
    expect(res.statusCode).toBe(429)
    expect(JSON.parse(res.body).message).toMatch(/10 active listings/)
  })

  it('201 — seller with exactly 9 active listings can still create one more', async () => {
    mockGetOrder.mockResolvedValue(makeHermesOrder())
    mockPrisma.fanListing.count.mockResolvedValue(9) // one below cap
    mockPrisma.fanListing.create.mockResolvedValue(makeCreatedListing())
    mockPrisma.listingAuditLog.create.mockResolvedValue({})

    const res = await app.inject({
      method: 'POST',
      url: '/v1/fan-sale/listings',
      cookies: { at: makeToken(42) },
      payload: validPayload,
    })
    expect(res.statusCode).toBe(201)
  })
})
