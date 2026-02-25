// MKPLS-363: POST /v1/fan-sale/listings/:id/fulfill
//
// Seller marks a SOLD listing as fulfilled (ticket transfer initiated).
// Atomically:
//   • listing.status        SOLD → FULFILLED
//   • fulfillment.status    PENDING → FULFILLED, sets fulfilledAt
//   • listingAuditLog entry { action: "fulfilled" }
// Then fires buyer notification (non-blocking).
//
// Error responses:
//   404 — listing not found OR not owned by this seller (no existence leak)
//   422 — listing.status !== 'SOLD'
//   422 — no PENDING fulfillment record exists for the listing

import { FastifyRequest, FastifyReply } from 'fastify'
import { NotificationService } from '../../../services/notifications'
import { toListingResponse } from '../../../lib/listing'
import { ListingResponse } from '../../../types'

const NON_FULFILLABLE_STATUSES = new Set(['ACTIVE', 'DELISTED', 'EXPIRED', 'FULFILLED'])

export const makeFulfillHandler =
  (notificationService: NotificationService) =>
  async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ): Promise<ListingResponse> => {
    const { id } = request.params
    const { accountId: sellerId } = request.user as { accountId: number }

    // --- 1. Find listing, enforce ownership ---
    const listing = await request.server.prisma.fanListing.findFirst({
      where: { id, sellerId },
    })
    if (!listing) {
      return reply.code(404).send({
        error: 'Not Found',
        message: 'Listing not found',
        statusCode: 404,
      })
    }

    // --- 2. Status gate — must be SOLD ---
    if (listing.status !== 'SOLD') {
      return reply.code(422).send({
        error: 'Unprocessable Entity',
        message: `Cannot fulfill a listing with status ${listing.status}`,
        statusCode: 422,
      })
    }

    // --- 3. Find the active (PENDING) fulfillment record ---
    const fulfillment = await request.server.prisma.fulfillment.findFirst({
      where: { listingId: id, status: 'PENDING' },
    })
    if (!fulfillment) {
      return reply.code(422).send({
        error: 'Unprocessable Entity',
        message: 'No active fulfillment record found for this listing',
        statusCode: 422,
      })
    }

    // --- 4. Atomic update ---
    const now = new Date()
    const [updatedListing] = await request.server.prisma.$transaction([
      request.server.prisma.fanListing.update({
        where: { id },
        data: { status: 'FULFILLED' },
      }),
      request.server.prisma.fulfillment.update({
        where: { id: fulfillment.id },
        data: { status: 'FULFILLED', fulfilledAt: now },
      }),
      request.server.prisma.listingAuditLog.create({
        data: {
          listingId: id,
          action: 'fulfilled',
          actorId: sellerId,
          metadata: null,
        },
      }),
    ])

    // --- 5. Notify buyer (fire-and-forget) ---
    notificationService.sendTicketTransferred(fulfillment.buyerOrderId).catch((err) => {
      request.log.error({ err, buyerOrderId: fulfillment.buyerOrderId }, 'Failed to send ticket transferred notification')
    })

    return toListingResponse(updatedListing)
  }
