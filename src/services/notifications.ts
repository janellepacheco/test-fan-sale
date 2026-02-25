// MKPLS-380–385: Fan Sale notification service
//
// Defines typed payloads and a NotificationService interface for every fan sale
// notification event. The HermesNotificationService implementation delivers via
// Hermes POST /api/notifications. All methods are fire-and-forget safe — callers
// should catch and log errors rather than letting notification failures block core ops.

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type NotificationChannel = 'push' | 'email'

// ---------------------------------------------------------------------------
// Per-event payload types
// ---------------------------------------------------------------------------

/** MKPLS-380: seller notified when their listing sells */
export interface ListingSoldParams {
  sellerId: number
  eventName: string
  eventDate: string    // ISO 8601
  section: string
  row: string
  seatNumber: string
  payoutAmountCents: number
  fulfillmentDeadline: Date
  fulfillmentDeepLink: string
}

/** MKPLS-381 / MKPLS-367: seller reminded to complete transfer before deadline */
export interface FulfillmentReminderParams {
  sellerId: number
  fulfillmentId: string
  eventName: string
  deadline: Date
  fulfillmentDeepLink: string
}

/** MKPLS-382: buyer notified that seller has marked tickets as transferred */
export interface TicketTransferredParams {
  buyerUserId: number
  buyerOrderId: string
  eventName: string
  eventDate: string    // ISO 8601
  section: string
  row: string
  seatNumber: string
  ticketSource: string  // e.g. 'ticketmaster' | 'axs' — tells buyer where to look
}

/** MKPLS-383: seller notified when payout is disbursed */
export interface PayoutSentParams {
  sellerId: number
  amountCents: number
  destinationMethod: string   // 'bank_transfer' | 'paypal' etc.
  expectedArrivalDate: Date
  payoutHistoryDeepLink: string
}

/** MKPLS-384: both buyer and seller notified when fulfillment deadline is missed */
export interface FulfillmentFailedParams {
  sellerId: number
  buyerUserId: number
  buyerOrderId: string
  eventName: string
}

/** MKPLS-385: seller notified of KYC outcome from Adyen webhook */
export interface KycOutcomeParams {
  sellerId: number
  outcome: 'verified' | 'failed'
  failureReason?: string
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface NotificationService {
  /** MKPLS-380 */
  sendListingSold(params: ListingSoldParams): Promise<void>
  /** MKPLS-381 / MKPLS-367 */
  sendFulfillmentReminder(params: FulfillmentReminderParams): Promise<void>
  /** MKPLS-382 */
  sendTicketTransferred(params: TicketTransferredParams): Promise<void>
  /** MKPLS-383 */
  sendPayoutSent(params: PayoutSentParams): Promise<void>
  /** MKPLS-384 */
  sendFulfillmentFailed(params: FulfillmentFailedParams): Promise<void>
  /** MKPLS-385 */
  sendKycOutcome(params: KycOutcomeParams): Promise<void>
}

// ---------------------------------------------------------------------------
// Stub — used on branches where notifications are not the focus
// ---------------------------------------------------------------------------

export class StubNotificationService implements NotificationService {
  async sendListingSold(_p: ListingSoldParams): Promise<void> {}
  async sendFulfillmentReminder(_p: FulfillmentReminderParams): Promise<void> {}
  async sendTicketTransferred(_p: TicketTransferredParams): Promise<void> {}
  async sendPayoutSent(_p: PayoutSentParams): Promise<void> {}
  async sendFulfillmentFailed(_p: FulfillmentFailedParams): Promise<void> {}
  async sendKycOutcome(_p: KycOutcomeParams): Promise<void> {}
}

// ---------------------------------------------------------------------------
// HermesNotificationService — production implementation
// ---------------------------------------------------------------------------

export class HermesNotificationService implements NotificationService {
  constructor(private readonly baseUrl: string) {}

  private async notify(
    event: string,
    recipientId: number,
    channels: NotificationChannel[],
    payload: Record<string, unknown>,
  ): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/notifications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, recipientId, channels, payload }),
    })
    if (!res.ok) {
      throw new Error(`Hermes notification failed [${event}]: HTTP ${res.status}`)
    }
  }

  // MKPLS-380
  async sendListingSold(p: ListingSoldParams): Promise<void> {
    await this.notify('listing_sold', p.sellerId, ['push', 'email'], {
      pushMessage: "Your tickets sold! Transfer them to receive your payout.",
      eventName: p.eventName,
      eventDate: p.eventDate,
      section: p.section,
      row: p.row,
      seatNumber: p.seatNumber,
      payoutAmountCents: p.payoutAmountCents,
      fulfillmentDeadline: p.fulfillmentDeadline.toISOString(),
      fulfillmentDeepLink: p.fulfillmentDeepLink,
    })
  }

  // MKPLS-381 / MKPLS-367
  async sendFulfillmentReminder(p: FulfillmentReminderParams): Promise<void> {
    await this.notify('fulfillment_reminder', p.sellerId, ['push', 'email'], {
      pushMessage: `Reminder: transfer your tickets by ${p.deadline.toISOString()} to receive your payout.`,
      eventName: p.eventName,
      deadline: p.deadline.toISOString(),
      fulfillmentDeepLink: p.fulfillmentDeepLink,
    })
  }

  // MKPLS-382
  async sendTicketTransferred(p: TicketTransferredParams): Promise<void> {
    const sourceLabel: Record<string, string> = {
      ticketmaster: 'Ticketmaster',
      axs: 'AXS',
      stubhub: 'StubHub',
      seatgeek: 'SeatGeek',
      vivid_seats: 'Vivid Seats',
    }
    const source = sourceLabel[p.ticketSource] ?? 'your ticket provider'
    await this.notify('ticket_transferred', p.buyerUserId, ['push', 'email'], {
      pushMessage: "Your tickets are on the way! Check your email for transfer instructions.",
      eventName: p.eventName,
      eventDate: p.eventDate,
      section: p.section,
      row: p.row,
      seatNumber: p.seatNumber,
      transferSource: source,
      supportEmail: 'support@vividseats.com',
    })
  }

  // MKPLS-383
  async sendPayoutSent(p: PayoutSentParams): Promise<void> {
    await this.notify('payout_sent', p.sellerId, ['push', 'email'], {
      pushMessage: `Your payout of $${(p.amountCents / 100).toFixed(2)} has been sent!`,
      amountCents: p.amountCents,
      destinationMethod: p.destinationMethod,
      expectedArrivalDate: p.expectedArrivalDate.toISOString(),
      payoutHistoryDeepLink: p.payoutHistoryDeepLink,
    })
  }

  // MKPLS-384 — sends two separate notifications (buyer + seller)
  async sendFulfillmentFailed(p: FulfillmentFailedParams): Promise<void> {
    await Promise.allSettled([
      this.notify('fulfillment_failed_buyer', p.buyerUserId, ['push', 'email'], {
        pushMessage: "We're sorry — your order couldn't be fulfilled. A refund is processing.",
        eventName: p.eventName,
        buyerOrderId: p.buyerOrderId,
        supportEmail: 'support@vividseats.com',
      }),
      this.notify('fulfillment_failed_seller', p.sellerId, ['push', 'email'], {
        pushMessage: "A fulfillment failure has been recorded on your account.",
        eventName: p.eventName,
        suspensionWarning: true,
        supportEmail: 'support@vividseats.com',
      }),
    ])
  }

  // MKPLS-385
  async sendKycOutcome(p: KycOutcomeParams): Promise<void> {
    if (p.outcome === 'verified') {
      await this.notify('kyc_verified', p.sellerId, ['push', 'email'], {
        pushMessage: "Identity verified! You're ready to list your tickets.",
        createListingDeepLink: '/fan-sale/listings/new',
      })
    } else {
      await this.notify('kyc_failed', p.sellerId, ['push', 'email'], {
        pushMessage: "Identity verification failed. Please review and resubmit.",
        failureReason: p.failureReason ?? 'Unable to verify identity',
        correctionSteps: [
          'Ensure your government ID is valid and unexpired',
          'Check that your name and address match your ID exactly',
          'Re-submit from the Payout Setup screen',
        ],
        supportEmail: 'support@vividseats.com',
      })
    }
  }
}
