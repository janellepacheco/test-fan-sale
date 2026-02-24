// MKPLS-359: DELETE /api/v1/fan-sale/listings/:id — delist listing
//
// Soft-deletes an ACTIVE listing by setting its status to DELISTED.
// The listing is removed from buyer-facing inventory immediately because
// all buyer-facing queries filter for status = ACTIVE.
//
// 404 is returned for both "not found" and "not owned" — same reasoning as
// update-listing: leaking existence to non-owners is a privacy concern.

import { FastifyReply, FastifyRequest } from 'fastify'
import { Prisma } from '@prisma/client'
import { toListingResponse } from '../../../../lib/listing'

// Statuses that cannot be delisted. DELISTED itself is included:
// attempting to delist an already-delisted listing is a no-op error,
// not a silent 200, to prevent confusing double-delist audit entries.
const NON_DELISTABLE_STATUSES = new Set(['SOLD', 'DELISTED', 'EXPIRED', 'FULFILLED'])

interface DelistParams {
  id: string
}

export async function delistHandler(
  request: FastifyRequest<{ Params: DelistParams }>,
  reply: FastifyReply,
) {
  // Fetch listing scoped to this seller — combines existence + ownership check
  const listing = await request.server.prisma.fanListing.findFirst({
    where: {
      id: request.params.id,
      sellerId: request.user.accountId,
    },
  })

  if (!listing) {
    return reply.code(404).send({
      error: 'Not Found',
      message: `Listing ${request.params.id} not found`,
      statusCode: 404,
    })
  }

  if (NON_DELISTABLE_STATUSES.has(listing.status)) {
    return reply.code(422).send({
      error: 'Unprocessable Entity',
      message: `Listing cannot be delisted in status ${listing.status}`,
      statusCode: 422,
    })
  }

  // Atomically update status + write audit log
  const updated = await request.server.prisma.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const delisted = await tx.fanListing.update({
        where: { id: listing.id },
        data: { status: 'DELISTED' },
      })

      await tx.listingAuditLog.create({
        data: {
          listingId: listing.id,
          action: 'delisted',
          actorId: request.user.accountId,
          metadata: null,
        },
      })

      return delisted
    },
  )

  return reply.code(200).send(toListingResponse(updated))
}
