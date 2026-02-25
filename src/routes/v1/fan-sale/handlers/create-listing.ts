// MKPLS-347: POST /api/v1/fan-sale/listings
//
// Creates a fan listing after verifying ticket ownership, running all
// eligibility rules, enforcing the velocity cap, and deduplicating on
// barcode hash. Writes an audit log record in the same transaction.

import { createHash } from 'crypto'
import { FastifyReply, FastifyRequest } from 'fastify'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { HermesClient, HermesOrder, HermesTicket } from '../../../../services/hermes'
import { FanListingStatus, ListingResponse, TicketSource } from '../../../../types'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const FEE_PERCENT = 0.15      // 15% platform fee — TODO: make per-event configurable
const MAX_ACTIVE_LISTINGS = 10       // MKPLS-387 velocity cap
const MAX_LISTING_DAYS = 90          // hard cap for far-future events

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

const CreateListingSchema = z.object({
  orderId: z.string().min(1, 'orderId is required'),
  ticketId: z.string().min(1, 'ticketId is required'),
  askingPrice: z
    .number({ invalid_type_error: 'askingPrice must be a number' })
    .positive('askingPrice must be positive')
    .max(10_000, 'askingPrice cannot exceed $10,000'),
})

export type CreateListingBody = z.infer<typeof CreateListingSchema>

// ---------------------------------------------------------------------------
// Pure helpers — fully testable without Fastify or DB
// ---------------------------------------------------------------------------

/**
 * SHA-256 of ticketId used as the barcode dedup key.
 * TODO: use actual barcode value from Hermes once exposed (MKPLS-346 follow-up)
 */
export function computeBarcodeHash(ticketId: string): string {
  return createHash('sha256').update(ticketId).digest('hex')
}

/**
 * Listing expires when the ticket can no longer be resold:
 * event start − 2 hours, capped at now + MAX_LISTING_DAYS.
 */
export function computeExpiresAt(eventDate: string, now: Date = new Date()): Date {
  const eventStart = new Date(eventDate)
  const listingCutoff = new Date(eventStart.getTime() - 2 * 60 * 60 * 1000)
  const maxExpiry = new Date(now.getTime() + MAX_LISTING_DAYS * 24 * 60 * 60 * 1000)
  return listingCutoff < maxExpiry ? listingCutoff : maxExpiry
}

/** Net payout = askingPrice × (1 − feePercent), rounded to 2 decimal places. */
export function computeEstimatedPayout(
  askingPrice: number,
  feePercent: number = FEE_PERCENT,
): number {
  return +(askingPrice * (1 - feePercent)).toFixed(2)
}

/**
 * Returns the first failing eligibility reason, or null if all rules pass.
 * Produces a specific message for the 422 response rather than a generic error.
 */
export function getIneligibilityReason(
  order: HermesOrder,
  ticket: HermesTicket,
  activeListingTicketIds: Set<string>,
  now: Date = new Date(),
): string | null {
  if (order.status !== 'confirmed')  return 'Order is not confirmed'
  if (order.hasActiveDispute)        return 'Order has an active dispute or chargeback'
  if (order.sellerSuspended)         return 'Seller account is suspended'
  if (ticket.scanned)                return 'Ticket has already been scanned'
  if (ticket.used)                   return 'Ticket has already been used'

  const cutoff = new Date(now.getTime() + 2 * 60 * 60 * 1000)
  if (new Date(ticket.eventDate) <= cutoff) return 'Event starts in less than 2 hours'

  if (activeListingTicketIds.has(ticket.ticketId)) return 'Ticket already has an active listing'

  return null
}

function normaliseSource(raw: string): TicketSource {
  const known = Object.values(TicketSource) as string[]
  return known.includes(raw) ? (raw as TicketSource) : TicketSource.OTHER
}

/**
 * Maps a Prisma FanListing row to the public ListingResponse shape.
 * Handles Decimal ↔ number coercion so callers stay type-safe.
 */
export function toListingResponse(listing: {
  id: string
  sellerId: number
  orderId: string
  ticketId: string
  ticketSource: string
  eventId: string
  section: string
  row: string
  seatNumber: string
  askingPrice: { toNumber(): number } | number
  feePercent: { toNumber(): number } | number
  status: string
  createdAt: Date
  expiresAt: Date
}): ListingResponse {
  const askingPrice =
    typeof listing.askingPrice === 'number'
      ? listing.askingPrice
      : listing.askingPrice.toNumber()
  const feePercent =
    typeof listing.feePercent === 'number'
      ? listing.feePercent
      : listing.feePercent.toNumber()

  return {
    id: listing.id,
    sellerId: listing.sellerId,
    orderId: listing.orderId,
    ticketId: listing.ticketId,
    ticketSource: normaliseSource(listing.ticketSource),
    eventId: listing.eventId,
    section: listing.section,
    row: listing.row,
    seatNumber: listing.seatNumber,
    askingPrice,
    estimatedPayout: computeEstimatedPayout(askingPrice, feePercent),
    status: listing.status as FanListingStatus,
    createdAt: listing.createdAt.toISOString(),
    expiresAt: listing.expiresAt.toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Fastify route handler
// ---------------------------------------------------------------------------

export function makeCreateListingHandler(hermesClient: HermesClient | null) {
  return async function createListingHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    // 1. Validate body
    const parsed = CreateListingSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'Invalid request body',
        statusCode: 400,
        details: parsed.error.flatten().fieldErrors,
      })
    }
    const body = parsed.data

    if (!hermesClient) {
      request.log.error('HERMES_SERVICE_URL is not configured')
      return reply.code(503).send({
        error: 'Service Unavailable',
        message: 'Order service not available',
        statusCode: 503,
      })
    }

    // 2. Fetch order from Hermes
    const bearerToken = request.cookies.at ?? ''
    let order
    try {
      order = await hermesClient.getOrder(body.orderId, bearerToken)
    } catch (err) {
      request.log.error({ err, orderId: body.orderId }, 'Hermes request failed')
      return reply.code(502).send({
        error: 'Bad Gateway',
        message: 'Unable to retrieve order details',
        statusCode: 502,
      })
    }

    if (!order) {
      return reply.code(404).send({
        error: 'Not Found',
        message: `Order ${body.orderId} not found`,
        statusCode: 404,
      })
    }

    // 3. Ownership check
    if (order.accountId !== request.user.accountId) {
      return reply.code(403).send({
        error: 'Forbidden',
        message: 'You do not own this order',
        statusCode: 403,
      })
    }

    // 4. Find the specific ticket inside the order
    const ticket = order.tickets.find((t) => t.ticketId === body.ticketId)
    if (!ticket) {
      return reply.code(422).send({
        error: 'Unprocessable Entity',
        message: `Ticket ${body.ticketId} was not found in order ${body.orderId}`,
        statusCode: 422,
      })
    }

    // 5. Eligibility check — check which tickets in this order are already listed
    const existingListings = await request.server.prisma.fanListing.findMany({
      where: {
        ticketId: { in: order.tickets.map((t) => t.ticketId) },
        status: 'ACTIVE',
      },
      select: { ticketId: true },
    })
    const activeListingTicketIds = new Set(existingListings.map((l: { ticketId: string }) => l.ticketId))

    const reason = getIneligibilityReason(order, ticket, activeListingTicketIds)
    if (reason) {
      return reply.code(422).send({
        error: 'Unprocessable Entity',
        message: reason,
        statusCode: 422,
      })
    }

    // 6. Velocity check — seller must have fewer than MAX_ACTIVE_LISTINGS
    const activeCount = await request.server.prisma.fanListing.count({
      where: { sellerId: request.user.accountId, status: 'ACTIVE' },
    })
    if (activeCount >= MAX_ACTIVE_LISTINGS) {
      return reply.code(429).send({
        error: 'Too Many Requests',
        message: `You may have at most ${MAX_ACTIVE_LISTINGS} active listings`,
        statusCode: 429,
      })
    }

    // 7. Barcode dedup — prevent the same physical ticket being listed twice
    const barcodeHash = computeBarcodeHash(body.ticketId)
    const duplicate = await request.server.prisma.fanListing.findFirst({
      where: { barcodeHash, status: 'ACTIVE' },
    })
    if (duplicate) {
      return reply.code(409).send({
        error: 'Conflict',
        message: 'This ticket is already listed for sale',
        statusCode: 409,
      })
    }

    // 8. Create listing + audit log in a single transaction
    const ticketSource = normaliseSource(ticket.ticketSource)
    const expiresAt = computeExpiresAt(ticket.eventDate)

    const listing = await request.server.prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        const created = await tx.fanListing.create({
          data: {
            sellerId: request.user.accountId,
            orderId: body.orderId,
            ticketId: body.ticketId,
            ticketSource,
            eventId: ticket.eventId,
            section: ticket.section,
            row: ticket.row,
            seatNumber: ticket.seatNumber,
            askingPrice: body.askingPrice,
            feePercent: FEE_PERCENT,
            barcodeHash,
            expiresAt,
          },
        })

        await tx.listingAuditLog.create({
          data: {
            listingId: created.id,
            action: 'created',
            actorId: request.user.accountId,
            metadata: { askingPrice: body.askingPrice },
          },
        })

        return created
      },
    )

    return reply.code(201).send(toListingResponse(listing))
  }
}
