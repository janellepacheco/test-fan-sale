// MKPLS-371: Payout release cron — runs every hour
//
// Finds FULFILLED listings where eventDate + 48h has passed and no INITIATED or
// COMPLETED payout exists, then calls AdyenPayoutService.releasePayout for each.
//
// "listing status is transferred" in the Jira AC maps to our FULFILLED status.
// Dispute checking is not yet implemented (no disputes table in v1 schema).
//
// On payout failure (after AdyenPayoutService's built-in 3x retry):
//   • Logs a structured error with PAYOUT_FAILED_MAX_RETRIES event key
//   • PagerDuty alerting picks this up via log-based alert rule — no direct PD SDK call.
//
// The cron function is a pure, injectable function; scheduling (setInterval / node-cron)
// is wired in src/index.ts so this module is easily unit-testable.

import type { PrismaClient } from '@prisma/client'
import type { AdyenPayoutService } from '../services/adyen-payout'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PayoutReleaseDeps {
  prisma: PrismaClient
  payoutService: AdyenPayoutService
  logger: {
    info(obj: Record<string, unknown>, msg: string): void
    warn(obj: Record<string, unknown>, msg: string): void
    error(obj: Record<string, unknown>, msg: string): void
  }
  /** VS commission as a decimal fraction — default 0.15 (15 %) */
  feePercent?: number
  /** 48h hold window in ms — injectable for testing */
  holdWindowMs?: number
}

export interface PayoutReleaseSummary {
  eligible: number
  initiated: number
  skipped: number
  failed: number
}

// ---------------------------------------------------------------------------
// Cron function
// ---------------------------------------------------------------------------

export async function runPayoutReleaseCron(
  deps: PayoutReleaseDeps,
): Promise<PayoutReleaseSummary> {
  const {
    prisma,
    payoutService,
    logger,
    feePercent = 0.15,
    holdWindowMs = 48 * 60 * 60 * 1000,
  } = deps

  const cutoff = new Date(Date.now() - holdWindowMs)

  // Find all FULFILLED listings past the hold window that have no active payout
  const listings = await prisma.fanListing.findMany({
    where: {
      status: 'FULFILLED',
      eventDate: { lte: cutoff },
      payouts: {
        none: { status: { in: ['INITIATED', 'COMPLETED'] } },
      },
    },
  })

  logger.info({ count: listings.length, cutoff }, 'payout-release: found eligible listings')

  const summary: PayoutReleaseSummary = {
    eligible: listings.length,
    initiated: 0,
    skipped: 0,
    failed: 0,
  }

  for (const listing of listings) {
    // -----------------------------------------------------------------------
    // 1. Load seller payment account — must be KYC_VERIFIED with stored card
    // -----------------------------------------------------------------------
    const spa = await prisma.sellerPaymentAccount.findUnique({
      where: { sellerId: listing.sellerId },
    })

    if (
      !spa?.adyenBalanceAccountId ||
      !spa?.paymentInstrumentId ||
      spa.kycStatus !== 'KYC_VERIFIED'
    ) {
      logger.warn(
        { listingId: listing.id, sellerId: listing.sellerId, kycStatus: spa?.kycStatus ?? null },
        'payout-release: seller not eligible for payout — skipping',
      )
      summary.skipped++
      continue
    }

    // -----------------------------------------------------------------------
    // 2. Compute net payout amount in minor units (cents)
    //    Net = askingPrice * (1 - feePercent), rounded to nearest cent
    // -----------------------------------------------------------------------
    const askingPrice = (listing.askingPrice as unknown as { toNumber(): number }).toNumber()
    const netAmountCents = Math.round(askingPrice * (1 - feePercent) * 100)

    // -----------------------------------------------------------------------
    // 3. Call Adyen Transfers API (retry built into AdyenPayoutService)
    // -----------------------------------------------------------------------
    try {
      const result = await payoutService.releasePayout({
        balanceAccountId: spa.adyenBalanceAccountId,
        paymentInstrumentId: spa.paymentInstrumentId,
        amountValue: netAmountCents,
        amountCurrency: 'USD',
        reference: listing.id,
      })

      // -------------------------------------------------------------------
      // 4. Write payout record
      // -------------------------------------------------------------------
      await prisma.payout.create({
        data: {
          sellerId: listing.sellerId,
          listingId: listing.id,
          transferId: result.transferId,
          amount: +(askingPrice * (1 - feePercent)).toFixed(2),
          status: 'INITIATED',
          initiatedAt: new Date(),
        },
      })

      logger.info(
        { listingId: listing.id, transferId: result.transferId, amountCents: netAmountCents },
        'payout-release: payout initiated',
      )
      summary.initiated++
    } catch (err) {
      // After 3 retries the service gives up and throws — log for PagerDuty alert rule
      logger.error(
        {
          event: 'PAYOUT_FAILED_MAX_RETRIES',
          err,
          listingId: listing.id,
          sellerId: listing.sellerId,
        },
        'payout-release: payout failed after max retries',
      )
      summary.failed++
    }
  }

  logger.info(summary, 'payout-release: run complete')
  return summary
}
