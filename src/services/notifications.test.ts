// MKPLS-380–385: HermesNotificationService unit tests

import {
  HermesNotificationService,
  StubNotificationService,
  ListingSoldParams,
  FulfillmentReminderParams,
  TicketTransferredParams,
  PayoutSentParams,
  FulfillmentFailedParams,
  KycOutcomeParams,
} from './notifications'

const BASE_URL = 'http://hermes-mock'
const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

let fetchSpy: jest.SpyInstance

beforeEach(() => {
  fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
  } as Response)
})

afterEach(() => fetchSpy.mockRestore())

function getBody() {
  return JSON.parse(fetchSpy.mock.calls[0][1].body as string)
}

// ---------------------------------------------------------------------------
// MKPLS-380: sendListingSold
// ---------------------------------------------------------------------------

describe('sendListingSold (MKPLS-380)', () => {
  const params: ListingSoldParams = {
    sellerId: 1,
    eventName: 'Coldplay',
    eventDate: '2026-06-01T19:00:00Z',
    section: 'A',
    row: '1',
    seatNumber: '5',
    payoutAmountCents: 6375,
    fulfillmentDeadline: FUTURE,
    fulfillmentDeepLink: '/fulfill/fl-001',
  }

  it('POSTs to /api/notifications with listing_sold event', async () => {
    const svc = new HermesNotificationService(BASE_URL)
    await svc.sendListingSold(params)
    expect(fetchSpy).toHaveBeenCalledWith(
      `${BASE_URL}/api/notifications`,
      expect.objectContaining({ method: 'POST' }),
    )
    expect(getBody().event).toBe('listing_sold')
  })

  it('sends to both push and email channels', async () => {
    await new HermesNotificationService(BASE_URL).sendListingSold(params)
    expect(getBody().channels).toEqual(expect.arrayContaining(['push', 'email']))
  })

  it('includes push message, payout amount, and deadline in payload', async () => {
    await new HermesNotificationService(BASE_URL).sendListingSold(params)
    const { payload } = getBody()
    expect(payload.pushMessage).toContain('sold')
    expect(payload.payoutAmountCents).toBe(6375)
    expect(payload.fulfillmentDeadline).toBeDefined()
  })

  it('throws when Hermes returns non-2xx', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 503 } as Response)
    await expect(
      new HermesNotificationService(BASE_URL).sendListingSold(params),
    ).rejects.toThrow('listing_sold')
  })
})

// ---------------------------------------------------------------------------
// MKPLS-381 / MKPLS-367: sendFulfillmentReminder
// ---------------------------------------------------------------------------

describe('sendFulfillmentReminder (MKPLS-381)', () => {
  const params: FulfillmentReminderParams = {
    sellerId: 2,
    fulfillmentId: 'ful-001',
    eventName: 'Taylor Swift',
    deadline: FUTURE,
    fulfillmentDeepLink: '/fulfill/ful-001',
  }

  it('sends fulfillment_reminder event to seller', async () => {
    await new HermesNotificationService(BASE_URL).sendFulfillmentReminder(params)
    const body = getBody()
    expect(body.event).toBe('fulfillment_reminder')
    expect(body.recipientId).toBe(2)
  })

  it('includes deadline and deep link in payload', async () => {
    await new HermesNotificationService(BASE_URL).sendFulfillmentReminder(params)
    const { payload } = getBody()
    expect(payload.deadline).toBeDefined()
    expect(payload.fulfillmentDeepLink).toBe('/fulfill/ful-001')
  })
})

// ---------------------------------------------------------------------------
// MKPLS-382: sendTicketTransferred
// ---------------------------------------------------------------------------

describe('sendTicketTransferred (MKPLS-382)', () => {
  const params: TicketTransferredParams = {
    buyerUserId: 3,
    buyerOrderId: 'ord-001',
    eventName: 'Beyoncé',
    eventDate: '2026-07-04T20:00:00Z',
    section: 'B',
    row: '2',
    seatNumber: '10',
    ticketSource: 'ticketmaster',
  }

  it('sends ticket_transferred event to buyer', async () => {
    await new HermesNotificationService(BASE_URL).sendTicketTransferred(params)
    const body = getBody()
    expect(body.event).toBe('ticket_transferred')
    expect(body.recipientId).toBe(3)
  })

  it('maps ticketmaster source to a friendly label in payload', async () => {
    await new HermesNotificationService(BASE_URL).sendTicketTransferred(params)
    expect(getBody().payload.transferSource).toBe('Ticketmaster')
  })

  it('falls back gracefully for unknown ticket source', async () => {
    await new HermesNotificationService(BASE_URL).sendTicketTransferred({
      ...params,
      ticketSource: 'unknown_platform',
    })
    expect(getBody().payload.transferSource).toBe('your ticket provider')
  })
})

// ---------------------------------------------------------------------------
// MKPLS-383: sendPayoutSent
// ---------------------------------------------------------------------------

describe('sendPayoutSent (MKPLS-383)', () => {
  const params: PayoutSentParams = {
    sellerId: 4,
    amountCents: 8500,
    destinationMethod: 'bank_transfer',
    expectedArrivalDate: FUTURE,
    payoutHistoryDeepLink: '/seller/payouts',
  }

  it('sends payout_sent event to seller', async () => {
    await new HermesNotificationService(BASE_URL).sendPayoutSent(params)
    expect(getBody().event).toBe('payout_sent')
  })

  it('includes formatted amount and destination in payload', async () => {
    await new HermesNotificationService(BASE_URL).sendPayoutSent(params)
    const { payload } = getBody()
    expect(payload.amountCents).toBe(8500)
    expect(payload.pushMessage).toContain('85.00')
  })
})

// ---------------------------------------------------------------------------
// MKPLS-384: sendFulfillmentFailed
// ---------------------------------------------------------------------------

describe('sendFulfillmentFailed (MKPLS-384)', () => {
  const params: FulfillmentFailedParams = {
    sellerId: 5,
    buyerUserId: 6,
    buyerOrderId: 'ord-002',
    eventName: 'Drake',
  }

  it('sends two separate notifications (buyer + seller)', async () => {
    await new HermesNotificationService(BASE_URL).sendFulfillmentFailed(params)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('buyer notification mentions refund', async () => {
    await new HermesNotificationService(BASE_URL).sendFulfillmentFailed(params)
    const buyerBody = JSON.parse(fetchSpy.mock.calls[0][1].body as string)
    expect(buyerBody.payload.pushMessage).toContain('refund')
  })

  it('seller notification warns about suspension risk', async () => {
    await new HermesNotificationService(BASE_URL).sendFulfillmentFailed(params)
    const sellerBody = JSON.parse(fetchSpy.mock.calls[1][1].body as string)
    expect(sellerBody.payload.suspensionWarning).toBe(true)
  })

  it('completes even if one notification fails (allSettled)', async () => {
    fetchSpy
      .mockResolvedValueOnce({ ok: false, status: 500 } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response)
    // Should not throw
    await expect(
      new HermesNotificationService(BASE_URL).sendFulfillmentFailed(params),
    ).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// MKPLS-385: sendKycOutcome
// ---------------------------------------------------------------------------

describe('sendKycOutcome (MKPLS-385)', () => {
  it('sends kyc_verified event with create listing deep link', async () => {
    await new HermesNotificationService(BASE_URL).sendKycOutcome({
      sellerId: 7,
      outcome: 'verified',
    })
    const body = getBody()
    expect(body.event).toBe('kyc_verified')
    expect(body.payload.createListingDeepLink).toBeDefined()
  })

  it('sends kyc_failed event with failure reason and correction steps', async () => {
    await new HermesNotificationService(BASE_URL).sendKycOutcome({
      sellerId: 8,
      outcome: 'failed',
      failureReason: 'ID expired',
    })
    const body = getBody()
    expect(body.event).toBe('kyc_failed')
    expect(body.payload.failureReason).toBe('ID expired')
    expect(Array.isArray(body.payload.correctionSteps)).toBe(true)
  })

  it('uses default failure reason when none provided', async () => {
    await new HermesNotificationService(BASE_URL).sendKycOutcome({
      sellerId: 9,
      outcome: 'failed',
    })
    expect(getBody().payload.failureReason).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// StubNotificationService — all methods resolve silently
// ---------------------------------------------------------------------------

describe('StubNotificationService', () => {
  const stub = new StubNotificationService()

  it('all methods resolve without throwing', async () => {
    await expect(stub.sendListingSold({} as never)).resolves.toBeUndefined()
    await expect(stub.sendFulfillmentReminder({} as never)).resolves.toBeUndefined()
    await expect(stub.sendTicketTransferred({} as never)).resolves.toBeUndefined()
    await expect(stub.sendPayoutSent({} as never)).resolves.toBeUndefined()
    await expect(stub.sendFulfillmentFailed({} as never)).resolves.toBeUndefined()
    await expect(stub.sendKycOutcome({} as never)).resolves.toBeUndefined()
  })
})
