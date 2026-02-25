// MKPLS-375 + MKPLS-378: GET /v1/inventory/events/:eventId
//
// Returns a unified inventory of fan listings (from this service's DB) and
// broker listings (from Hermes), merged and sorted by price.
//
// Fan listing exclusion rule: listings are dropped when eventDate is within 2h
// of the current time — late arrivals can't reliably transfer tickets.
//
// Query params (MKPLS-375):
//   section     — filter by section (case-insensitive prefix match)
//   minPrice    — minimum price in USD
//   maxPrice    — maximum price in USD
//   minQuantity — minimum quantity (fan listings are always 1)
//   sortBy      — price_asc (default) | price_desc
//
// Query params (MKPLS-378):
//   source      — fan | broker | omit for all

import { FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { HermesClient, BrokerListing } from '../../../../services/hermes'
import { env } from '../../../../plugins/env'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InventorySource = 'fan' | 'broker'

export interface InventoryItem {
  id: string
  source: InventorySource
  section: string
  row: string
  seatNumber?: string
  quantity: number
  price: number
  ticketSource?: string  // fan listings only
}

export interface EventInventoryResponse {
  eventId: string
  listings: InventoryItem[]
  total: number
}

// ---------------------------------------------------------------------------
// Query schema
// ---------------------------------------------------------------------------

const QuerySchema = z.object({
  section: z.string().optional(),
  minPrice: z.coerce.number().nonnegative().optional(),
  maxPrice: z.coerce.number().nonnegative().optional(),
  minQuantity: z.coerce.number().int().min(1).optional(),
  sortBy: z.enum(['price_asc', 'price_desc']).default('price_asc'),
  source: z.enum(['fan', 'broker']).optional(),
})

// Fan listings within 2h of event start are excluded from inventory
const TWO_HOURS_MS = 2 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Handler factory — accepts HermesClient for testability
// ---------------------------------------------------------------------------

export const makeEventInventoryHandler =
  (hermesClient: HermesClient) =>
  async (
    request: FastifyRequest<{
      Params: { eventId: string }
      Querystring: Record<string, string>
    }>,
    reply: FastifyReply,
  ): Promise<EventInventoryResponse> => {
    const { eventId } = request.params

    const parsed = QuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: parsed.error.flatten().fieldErrors,
        statusCode: 400,
      })
    }
    const { section, minPrice, maxPrice, minQuantity, sortBy, source } = parsed.data

    const cutoff = new Date(Date.now() + TWO_HOURS_MS)
    const listings: InventoryItem[] = []

    // -----------------------------------------------------------------------
    // 1. Fan listings (skip when source=broker)
    // -----------------------------------------------------------------------
    if (source !== 'broker') {
      const where: Record<string, unknown> = {
        eventId,
        status: 'ACTIVE',
        // Exclude listings within 2h of the event
        expiresAt: { gt: cutoff },
        ...(section && { section: { equals: section, mode: 'insensitive' } }),
        ...(minPrice !== undefined && { askingPrice: { gte: minPrice } }),
        ...(maxPrice !== undefined && { askingPrice: { lte: maxPrice } }),
      }

      const fanListings = await request.server.prisma.fanListing.findMany({ where })

      for (const l of fanListings) {
        const price = (l.askingPrice as unknown as { toNumber(): number }).toNumber()
        if (minQuantity !== undefined && minQuantity > 1) continue  // fan = always qty 1
        listings.push({
          id: l.id,
          source: 'fan',
          section: l.section,
          row: l.row,
          seatNumber: l.seatNumber,
          quantity: 1,
          price,
          ticketSource: l.ticketSource,
        })
      }
    }

    // -----------------------------------------------------------------------
    // 2. Broker listings from Hermes (skip when source=fan)
    // -----------------------------------------------------------------------
    if (source !== 'fan') {
      try {
        const brokerListings: BrokerListing[] = await hermesClient.getEventInventory(eventId, {
          section,
          minPrice,
          maxPrice,
          minQuantity,
        })

        for (const l of brokerListings) {
          listings.push({
            id: l.id,
            source: 'broker',
            section: l.section,
            row: l.row,
            seatNumber: l.seatNumber,
            quantity: l.quantity,
            price: l.price,
          })
        }
      } catch (err) {
        // Broker inventory failure degrades gracefully — return fan-only results
        request.log.error({ err, eventId }, 'inventory: Hermes call failed, returning fan-only results')
      }
    }

    // -----------------------------------------------------------------------
    // 3. Sort unified result
    // -----------------------------------------------------------------------
    listings.sort((a, b) =>
      sortBy === 'price_asc' ? a.price - b.price : b.price - a.price,
    )

    return {
      eventId,
      listings,
      total: listings.length,
    }
  }

// Default export wired with the real Hermes client
export function makeDefaultEventInventoryHandler() {
  const hermesUrl = env.HERMES_SERVICE_URL ?? 'http://hermes'
  return makeEventInventoryHandler(new HermesClient(hermesUrl))
}
