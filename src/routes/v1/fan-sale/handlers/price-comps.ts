// MKPLS-353: GET /api/v1/fan-sale/price-comps — market comps API
//
// Returns min, max, median, count for a given event/section/row.
// Falls back to event-level stats when the section/row bucket has < 3 listings.
// Results are cached in Redis with a configurable TTL (default 300 s).
// The cache is optional — if Redis is unavailable the handler queries the DB directly.

import { FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { env } from '../../../../plugins/env'
import { PriceComp, PriceCompsResponse } from '../../../../types'

// ---------------------------------------------------------------------------
// Query string validation
// ---------------------------------------------------------------------------

const PriceCompsQuerySchema = z.object({
  eventId: z.string().min(1, 'eventId is required'),
  section: z.string().optional(),
  row: z.string().optional(),
})

export type PriceCompsQuery = z.infer<typeof PriceCompsQuerySchema>

// ---------------------------------------------------------------------------
// Pure stat helpers — fully unit-testable
// ---------------------------------------------------------------------------

/** Ascending numeric sort (does not mutate the input array). */
export function sortedPrices(prices: number[]): number[] {
  return [...prices].sort((a, b) => a - b)
}

/**
 * Median of a pre-sorted array.
 * Even-length arrays average the two middle values, rounded to 2 dp.
 */
export function median(sorted: number[]): number {
  if (sorted.length === 0) return 0
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : +((sorted[mid - 1] + sorted[mid]) / 2).toFixed(2)
}

/**
 * Builds the PriceCompsResponse from raw DB rows.
 * `rows` must already be filtered to the desired scope (section/row or event-level).
 */
export function buildCompsResponse(
  eventId: string,
  rows: { id: string; section: string; row: string; askingPrice: number; quantity: number }[],
): PriceCompsResponse {
  const prices = rows.map((r) => r.askingPrice)
  const sorted = sortedPrices(prices)

  const comps: PriceComp[] = rows.map((r) => ({
    listingId: r.id,
    section: r.section,
    row: r.row,
    askingPrice: r.askingPrice,
    quantity: r.quantity,
  }))

  return {
    eventId,
    comps,
    suggestedPrice: median(sorted),
    minPrice: sorted[0] ?? 0,
    maxPrice: sorted[sorted.length - 1] ?? 0,
  }
}

// ---------------------------------------------------------------------------
// Cache key
// ---------------------------------------------------------------------------

export function cacheKey(eventId: string, section?: string, row?: string): string {
  const parts = ['price-comps', eventId]
  if (section) parts.push(`s:${section}`)
  if (row)     parts.push(`r:${row}`)
  return parts.join(':')
}

// ---------------------------------------------------------------------------
// DB query helpers
// ---------------------------------------------------------------------------

const MIN_LISTINGS_FOR_SCOPED_QUERY = 3

type PrismaLike = {
  fanListing: {
    findMany: (args: object) => Promise<{
      id: string
      section: string
      row: string
      askingPrice: { toNumber(): number } | number
    }[]>
  }
}

async function queryListings(
  prisma: PrismaLike,
  where: object,
): Promise<{ id: string; section: string; row: string; askingPrice: number; quantity: number }[]> {
  const rows = await prisma.fanListing.findMany({
    where: { ...where, status: 'ACTIVE' },
    select: { id: true, section: true, row: true, askingPrice: true },
  })

  return rows.map((r) => ({
    id: r.id,
    section: r.section,
    row: r.row,
    askingPrice: typeof r.askingPrice === 'number' ? r.askingPrice : r.askingPrice.toNumber(),
    quantity: 1, // one row = one ticket; quantity is structural for future multi-ticket listings
  }))
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function priceCompsHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  // 1. Validate query string
  const parsed = PriceCompsQuerySchema.safeParse(request.query)
  if (!parsed.success) {
    return reply.code(400).send({
      error: 'Bad Request',
      message: 'Invalid query parameters',
      statusCode: 400,
      details: parsed.error.flatten().fieldErrors,
    })
  }
  const { eventId, section, row } = parsed.data

  // 2. Cache read
  const key = cacheKey(eventId, section, row)
  if (request.server.redis) {
    const cached = await request.server.redis.get(key)
    if (cached) {
      reply.header('X-Cache', 'HIT')
      return reply.code(200).send(JSON.parse(cached) as PriceCompsResponse)
    }
  }

  // 3. Query DB — scoped to section/row if provided, fallback to event-level
  let rows = await queryListings(request.server.prisma, { eventId, ...(section && { section }), ...(row && { row }) })

  if (rows.length < MIN_LISTINGS_FOR_SCOPED_QUERY && (section || row)) {
    // Not enough data at the requested granularity — widen to event-level
    request.log.info({ eventId, section, row }, 'price-comps: fewer than 3 listings in scope, falling back to event-level')
    rows = await queryListings(request.server.prisma, { eventId })
  }

  const response = buildCompsResponse(eventId, rows)

  // 4. Cache write (fire-and-forget — a failed cache write must not fail the request)
  if (request.server.redis) {
    request.server.redis
      .setEx(key, env.PRICE_COMPS_TTL_SECONDS, JSON.stringify(response))
      .catch((err) => request.log.warn({ err, key }, 'price-comps: Redis setEx failed'))
    reply.header('X-Cache', 'MISS')
  }

  return reply.code(200).send(response)
}
