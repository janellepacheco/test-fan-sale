// MKPLS-367 + MKPLS-381: Fulfillment reminder cron
//
// Runs every 15 minutes. Finds PENDING fulfillments whose deadline falls within
// a ±window around the 4-hour mark (default: deadlineAt between now+3h45m and now+4h15m).
// Sends a push + email reminder to the seller and marks the fulfillment as reminded
// via Redis so only one reminder is ever sent per fulfillment.

import { PrismaClient } from '@prisma/client'
import { NotificationService, StubNotificationService } from '../services/notifications'
import { RedisClient } from '../services/rate-limiter'

export interface FulfillmentReminderDeps {
  prisma: PrismaClient
  notificationService?: NotificationService
  redis: RedisClient
  logger: { info(msg: string, data?: unknown): void; error(msg: string, data?: unknown): void }
  reminderLeadMs?: number   // default 4h — how far before deadline to remind
  windowHalfMs?: number     // default 15min — ±window around the lead time
}

export interface FulfillmentReminderSummary {
  scanned: number
  reminded: number
  deduped: number
  failed: number
}

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000
const FIFTEEN_MIN_MS = 15 * 60 * 1000

export async function runFulfillmentReminderCron(
  deps: FulfillmentReminderDeps,
): Promise<FulfillmentReminderSummary> {
  const {
    prisma,
    notificationService = new StubNotificationService(),
    redis,
    logger,
    reminderLeadMs = FOUR_HOURS_MS,
    windowHalfMs = FIFTEEN_MIN_MS,
  } = deps

  const now = Date.now()
  // Target window: deadlines that are approximately (reminderLeadMs) away
  const windowStart = new Date(now + reminderLeadMs - windowHalfMs)
  const windowEnd = new Date(now + reminderLeadMs + windowHalfMs)

  const pendingFulfillments = await prisma.fulfillment.findMany({
    where: {
      status: 'PENDING',
      deadlineAt: { gte: windowStart, lte: windowEnd },
    },
    include: {
      listing: {
        select: {
          sellerId: true,
          eventId: true,
          section: true,
          row: true,
          seatNumber: true,
        },
      },
    },
  })

  const summary: FulfillmentReminderSummary = {
    scanned: pendingFulfillments.length,
    reminded: 0,
    deduped: 0,
    failed: 0,
  }

  for (const fulfillment of pendingFulfillments) {
    const dedupKey = `fulfillment_reminder_sent:${fulfillment.id}`

    // Dedup: skip if reminder was already sent
    const alreadySent = await redis.zcard(dedupKey)
    if (alreadySent > 0) {
      summary.deduped++
      continue
    }

    try {
      await notificationService.sendFulfillmentReminder({
        sellerId: fulfillment.listing.sellerId,
        fulfillmentId: fulfillment.id,
        eventName: fulfillment.listing.eventId, // resolved to name at route layer
        deadline: fulfillment.deadlineAt,
        fulfillmentDeepLink: `/fan-sale/fulfillments/${fulfillment.id}`,
      })

      // Mark as reminded — 7-day TTL (well past any realistic fulfillment window)
      const ts = Date.now()
      await redis.zadd(dedupKey, ts, String(ts))
      await redis.expire(dedupKey, 7 * 24 * 60 * 60)

      summary.reminded++
    } catch (err) {
      logger.error('fulfillment_reminder_cron: notification failed', {
        fulfillmentId: fulfillment.id,
        err,
      })
      summary.failed++
    }
  }

  logger.info('fulfillment_reminder_cron: complete', summary)
  return summary
}
