// MKPLS-364: Fulfillment deadline enforcement cron — runs every 15 minutes
//
// Finds PENDING fulfillments whose deadlineAt has passed, then for each:
//   1. Atomically marks fulfillment FAILED + listing DELISTED + inserts SellerFlag
//   2. Initiates a buyer refund via RefundService (Adyen — Adyen-only arch decision)
//   3. Checks seller's total fulfillment_failure flags; suspends if >= 2
//
// Idempotency: the initial query only fetches PENDING records, so re-runs skip
// anything already processed by a previous cron tick.
//
// PagerDuty: if failures in a single run exceed the threshold (default 10),
// logs FULFILLMENT_DEADLINE_FAILURE_THRESHOLD event key for alert rule pickup.

import type { PrismaClient } from '@prisma/client'

// ---------------------------------------------------------------------------
// RefundService interface
// Adyen-only per arch decision; interface is kept narrow so tests can stub it.
// ---------------------------------------------------------------------------

export interface RefundService {
  initiateRefund(params: {
    buyerOrderId: string
    amountValue: number
    amountCurrency: string
    reference: string
  }): Promise<{ refundId: string }>
}

/** No-op stub — swap for a real Adyen Refunds client in production wiring */
export class StubRefundService implements RefundService {
  async initiateRefund(): Promise<{ refundId: string }> {
    return { refundId: 'stub-refund' }
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FulfillmentDeadlineDeps {
  prisma: PrismaClient
  refundService: RefundService
  logger: {
    info(obj: Record<string, unknown>, msg: string): void
    warn(obj: Record<string, unknown>, msg: string): void
    error(obj: Record<string, unknown>, msg: string): void
  }
  /** PagerDuty alert threshold — default 10 failures per run */
  alertThreshold?: number
}

export interface FulfillmentDeadlineSummary {
  overdue: number
  processed: number
  failed: number
  suspended: number
}

// ---------------------------------------------------------------------------
// Cron function
// ---------------------------------------------------------------------------

export async function runFulfillmentDeadlineCron(
  deps: FulfillmentDeadlineDeps,
): Promise<FulfillmentDeadlineSummary> {
  const { prisma, refundService, logger, alertThreshold = 10 } = deps

  const now = new Date()

  // Find all PENDING fulfillments past their deadline, including the listing
  const overdueFulfillments = await prisma.fulfillment.findMany({
    where: {
      status: 'PENDING',
      deadlineAt: { lte: now },
    },
    include: { listing: true },
  })

  logger.info(
    { count: overdueFulfillments.length },
    'fulfillment-deadline: found overdue fulfillments',
  )

  const summary: FulfillmentDeadlineSummary = {
    overdue: overdueFulfillments.length,
    processed: 0,
    failed: 0,
    suspended: 0,
  }

  for (const fulfillment of overdueFulfillments) {
    const { listing } = fulfillment

    try {
      // -----------------------------------------------------------------
      // 1. Atomic write: fail fulfillment + delist listing + flag seller
      // -----------------------------------------------------------------
      await prisma.$transaction([
        prisma.fulfillment.update({
          where: { id: fulfillment.id },
          data: { status: 'FAILED' },
        }),
        prisma.fanListing.update({
          where: { id: listing.id },
          data: { status: 'DELISTED' },
        }),
        prisma.sellerFlag.create({
          data: {
            sellerId: listing.sellerId,
            reason: 'fulfillment_failure',
            fulfillmentId: fulfillment.id,
          },
        }),
      ])

      // -----------------------------------------------------------------
      // 2. Initiate buyer refund (Adyen; fire-and-forget on error logged)
      // -----------------------------------------------------------------
      try {
        const askingPrice = (listing.askingPrice as unknown as { toNumber(): number }).toNumber()
        await refundService.initiateRefund({
          buyerOrderId: fulfillment.buyerOrderId,
          amountValue: Math.round(askingPrice * 100),
          amountCurrency: 'USD',
          reference: fulfillment.id,
        })
      } catch (refundErr) {
        logger.error(
          { refundErr, fulfillmentId: fulfillment.id, buyerOrderId: fulfillment.buyerOrderId },
          'fulfillment-deadline: buyer refund failed',
        )
        // Refund failure is logged but does not abort the flag/suspension logic
      }

      // -----------------------------------------------------------------
      // 3. Check flag count — suspend seller if >= 2 fulfillment_failure flags
      // -----------------------------------------------------------------
      const flagCount = await prisma.sellerFlag.count({
        where: { sellerId: listing.sellerId, reason: 'fulfillment_failure' },
      })

      if (flagCount >= 2) {
        await prisma.sellerPaymentAccount.upsert({
          where: { sellerId: listing.sellerId },
          update: { fanSaleSuspended: true },
          create: {
            sellerId: listing.sellerId,
            fanSaleSuspended: true,
          },
        })
        logger.warn(
          { sellerId: listing.sellerId, flagCount },
          'fulfillment-deadline: seller suspended (2+ fulfillment failures)',
        )
        summary.suspended++
      }

      logger.info(
        { fulfillmentId: fulfillment.id, sellerId: listing.sellerId },
        'fulfillment-deadline: fulfillment processed',
      )
      summary.processed++
    } catch (err) {
      logger.error(
        { err, fulfillmentId: fulfillment.id, sellerId: listing.sellerId },
        'fulfillment-deadline: failed to process fulfillment',
      )
      summary.failed++
    }
  }

  // PagerDuty alert if too many hard failures in one run
  if (summary.failed > alertThreshold) {
    logger.error(
      {
        event: 'FULFILLMENT_DEADLINE_FAILURE_THRESHOLD',
        failed: summary.failed,
        threshold: alertThreshold,
      },
      'fulfillment-deadline: failure count exceeded PagerDuty threshold',
    )
  }

  logger.info(summary, 'fulfillment-deadline: run complete')
  return summary
}
