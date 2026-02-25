// MKPLS-356: Stale listing re-price suggestion cron
//
// Runs every 6 hours. Finds ACTIVE listings that have been live > 48h and are
// priced above 120% of the current median for their event + section.
// Sends a re-price suggestion notification to the seller.
// Deduplication: max one notification per listing per 72 hours (Redis TTL key).

import { PrismaClient } from '@prisma/client'
import { NotificationService, StubNotificationService } from '../services/notifications'
import { RedisClient } from '../services/rate-limiter'

export interface StaleListingDeps {
  prisma: PrismaClient
  notificationService?: NotificationService
  redis: RedisClient
  logger: { info(msg: string, data?: unknown): void; warn(msg: string, data?: unknown): void; error(msg: string, data?: unknown): void }
  staleThresholdMs?: number    // default 48h
  priceThresholdRatio?: number // default 1.20 (120%)
  dedupWindowMs?: number       // default 72h
}

export interface StaleListingSummary {
  scanned: number
  overpriced: number
  notified: number
  deduped: number
}

const FORTY_EIGHT_HOURS = 48 * 60 * 60 * 1000
const SEVENTY_TWO_HOURS = 72 * 60 * 60 * 1000
const DEFAULT_RATIO = 1.20

export async function runStaleListingCron(deps: StaleListingDeps): Promise<StaleListingSummary> {
  const {
    prisma,
    notificationService = new StubNotificationService(),
    redis,
    logger,
    staleThresholdMs = FORTY_EIGHT_HOURS,
    priceThresholdRatio = DEFAULT_RATIO,
    dedupWindowMs = SEVENTY_TWO_HOURS,
  } = deps

  const staleCutoff = new Date(Date.now() - staleThresholdMs)

  // Fetch all ACTIVE listings older than the stale threshold
  const staleListings = await prisma.fanListing.findMany({
    where: {
      status: 'ACTIVE',
      createdAt: { lte: staleCutoff },
    },
    select: {
      id: true,
      sellerId: true,
      eventId: true,
      section: true,
      row: true,
      seatNumber: true,
      askingPrice: true,
      expiresAt: true,
    },
  })

  const summary: StaleListingSummary = {
    scanned: staleListings.length,
    overpriced: 0,
    notified: 0,
    deduped: 0,
  }

  if (staleListings.length === 0) {
    logger.info('stale_listing_cron: no stale listings', { staleCutoff })
    return summary
  }

  // Pre-compute medians per (eventId, section) to avoid N+1 queries
  const groupKeys = [...new Set(staleListings.map((l) => `${l.eventId}::${l.section}`))]
  const medianCache = new Map<string, number>()

  await Promise.all(
    groupKeys.map(async (key) => {
      const [eventId, section] = key.split('::')
      const prices = await prisma.fanListing.findMany({
        where: { eventId, section, status: 'ACTIVE' },
        select: { askingPrice: true },
        orderBy: { askingPrice: 'asc' },
      })
      if (prices.length === 0) return
      const mid = Math.floor(prices.length / 2)
      const median =
        prices.length % 2 === 0
          ? (prices[mid - 1].askingPrice.toNumber() + prices[mid].askingPrice.toNumber()) / 2
          : prices[mid].askingPrice.toNumber()
      medianCache.set(key, median)
    }),
  )

  for (const listing of staleListings) {
    const key = `${listing.eventId}::${listing.section}`
    const median = medianCache.get(key)

    if (median === undefined || median === 0) continue

    const price = listing.askingPrice.toNumber()
    const threshold = median * priceThresholdRatio

    if (price <= threshold) continue

    summary.overpriced++

    // Deduplication: skip if we already notified within the dedup window
    const dedupKey = `stale_reprice:${listing.id}`
    const alreadySent = await redis.zcard(dedupKey)

    if (alreadySent > 0) {
      summary.deduped++
      continue
    }

    try {
      await notificationService.sendListingSold({
        sellerId: listing.sellerId,
        eventName: listing.eventId,   // event name resolved at route layer; using id here
        eventDate: listing.expiresAt.toISOString(),
        section: listing.section,
        row: listing.row,
        seatNumber: listing.seatNumber,
        payoutAmountCents: Math.round(price * 100),
        fulfillmentDeadline: listing.expiresAt,
        fulfillmentDeepLink: `/fan-sale/listings/${listing.id}`,
      })

      // Mark as notified — use a sorted set with one member + TTL for simplicity
      const now = Date.now()
      await redis.zadd(dedupKey, now, String(now))
      await redis.expire(dedupKey, Math.ceil(dedupWindowMs / 1000))

      summary.notified++
    } catch (err) {
      logger.error('stale_listing_cron: notification failed', { listingId: listing.id, err })
    }
  }

  logger.info('stale_listing_cron: complete', summary)
  return summary
}
