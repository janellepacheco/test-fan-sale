// MKPLS-346: GET /api/v1/orders/:id/eligible-tickets
//
// Returns tickets from the given order that pass all eligibility rules.
// Ownership, order-level, and ticket-level rules are evaluated server-side.
// Ticket source is NOT an eligibility criterion — any platform passes.

import { FastifyReply, FastifyRequest } from 'fastify'
import { HermesClient, HermesOrder, HermesTicket } from '../../../../services/hermes'
import { EligibleTicket, EligibleTicketsResponse, TicketSource } from '../../../../types'

// ---------------------------------------------------------------------------
// Eligibility logic — pure functions, fully unit-testable without Fastify
// ---------------------------------------------------------------------------

const TWO_HOURS_MS = 2 * 60 * 60 * 1000

/**
 * Order-level gate: if any of these fail, zero tickets are eligible.
 * Avoids iterating per-ticket when the order itself is disqualified.
 */
export function isOrderEligible(order: HermesOrder): boolean {
  return (
    order.status === 'confirmed' &&
    !order.hasActiveDispute &&
    !order.sellerSuspended
  )
}

/**
 * Per-ticket eligibility. Order-level rules are assumed to have already passed.
 * `now` is injectable for deterministic testing.
 */
export function isTicketEligible(
  ticket: HermesTicket,
  activeListingTicketIds: Set<string>,
  now: Date = new Date(),
): boolean {
  const eventDate = new Date(ticket.eventDate)
  const cutoff = new Date(now.getTime() + TWO_HOURS_MS)

  return (
    !ticket.scanned &&
    !ticket.used &&
    eventDate > cutoff &&
    !activeListingTicketIds.has(ticket.ticketId)
  )
}

/**
 * Maps a HermesTicket to the public EligibleTicket shape.
 * Normalises ticketSource to the TicketSource enum; unknown values → OTHER.
 */
export function toEligibleTicket(ticket: HermesTicket): EligibleTicket {
  const knownSources = Object.values(TicketSource) as string[]
  const ticketSource = knownSources.includes(ticket.ticketSource)
    ? (ticket.ticketSource as TicketSource)
    : TicketSource.OTHER

  return {
    ticketId: ticket.ticketId,
    seatNumber: ticket.seatNumber,
    section: ticket.section,
    row: ticket.row,
    eventId: ticket.eventId,
    eventName: ticket.eventName,
    eventDate: ticket.eventDate,
    ticketSource,
  }
}

/**
 * Applies all eligibility rules and returns the passing tickets.
 * `now` is injectable so tests can pin time without mocking Date.
 */
export function filterEligibleTickets(
  order: HermesOrder,
  activeListingTicketIds: Set<string>,
  now: Date = new Date(),
): EligibleTicket[] {
  if (!isOrderEligible(order)) return []

  return order.tickets
    .filter((t) => isTicketEligible(t, activeListingTicketIds, now))
    .map(toEligibleTicket)
}

// ---------------------------------------------------------------------------
// Fastify route handler
// ---------------------------------------------------------------------------

interface EligibleTicketsParams {
  id: string
}

export function makeEligibleTicketsHandler(hermesClient: HermesClient) {
  return async function eligibleTicketsHandler(
    request: FastifyRequest<{ Params: EligibleTicketsParams }>,
    reply: FastifyReply,
  ): Promise<EligibleTicketsResponse> {
    const { id: orderId } = request.params

    if (!hermesClient) {
      request.log.error('HERMES_SERVICE_URL is not configured')
      return reply.code(503).send({
        error: 'Service Unavailable',
        message: 'Order service not available',
        statusCode: 503,
      })
    }

    // Forward the authenticated user's token to Hermes for service-to-service auth
    const bearerToken = request.cookies.at ?? ''

    let order
    try {
      order = await hermesClient.getOrder(orderId, bearerToken)
    } catch (err) {
      request.log.error({ err, orderId }, 'Hermes request failed')
      return reply.code(502).send({
        error: 'Bad Gateway',
        message: 'Unable to retrieve order details',
        statusCode: 502,
      })
    }

    if (!order) {
      return reply.code(404).send({
        error: 'Not Found',
        message: `Order ${orderId} not found`,
        statusCode: 404,
      })
    }

    // Ownership check — the authenticated seller must own the order
    if (order.accountId !== request.user.accountId) {
      return reply.code(403).send({
        error: 'Forbidden',
        message: 'You do not own this order',
        statusCode: 403,
      })
    }

    // Fetch ticket IDs that are already actively listed so we can exclude them
    const ticketIds = order.tickets.map((t) => t.ticketId)
    const existingListings = await request.server.prisma.fanListing.findMany({
      where: {
        ticketId: { in: ticketIds },
        status: 'ACTIVE',
      },
      select: { ticketId: true },
    })
    const activeListingTicketIds = new Set(existingListings.map((l) => l.ticketId))

    const eligible = filterEligibleTickets(order, activeListingTicketIds)

    return reply.code(200).send({ orderId, eligible })
  }
}
