// MKPLS-358: PATCH /api/v1/fan-sale/listings/:id — update listing price
//
// Allows a seller to reprice an ACTIVE listing.
// 404 is returned for both "not found" and "not owned" cases intentionally —
// leaking listing existence to non-owners is a data privacy concern.

import { FastifyReply, FastifyRequest } from 'fastify'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { toListingResponse } from '../../../../lib/listing'

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

const UpdateListingSchema = z.object({
  askingPrice: z
    .number({ invalid_type_error: 'askingPrice must be a number' })
    .min(1.00, 'askingPrice must be at least $1.00')
    .max(10_000, 'askingPrice cannot exceed $10,000'),
})

export type UpdateListingBody = z.infer<typeof UpdateListingSchema>

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Normalises a Prisma Decimal or plain number to a JS number.
 * Used to pass oldPrice into the audit log metadata.
 */
export function toNum(v: { toNumber(): number } | number): number {
  return typeof v === 'number' ? v : v.toNumber()
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

interface UpdateListingParams {
  id: string
}

export async function updateListingHandler(
  request: FastifyRequest<{ Params: UpdateListingParams }>,
  reply: FastifyReply,
) {
  // 1. Validate body
  const parsed = UpdateListingSchema.safeParse(request.body)
  if (!parsed.success) {
    return reply.code(400).send({
      error: 'Bad Request',
      message: 'Invalid request body',
      statusCode: 400,
      details: parsed.error.flatten().fieldErrors,
    })
  }
  const { askingPrice } = parsed.data

  // 2. Fetch listing — scoped to this seller so ownership is checked in one query.
  //    Returning 404 for both "not found" and "wrong owner" is intentional.
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

  // 3. Status gate — only ACTIVE listings can be repriced
  if (listing.status !== 'ACTIVE') {
    return reply.code(422).send({
      error: 'Unprocessable Entity',
      message: `Listing cannot be repriced in status ${listing.status}`,
      statusCode: 422,
    })
  }

  // 4. Update price + write audit log atomically
  const oldPrice = toNum(listing.askingPrice)

  const updated = await request.server.prisma.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const updatedListing = await tx.fanListing.update({
        where: { id: listing.id },
        data: { askingPrice },
      })

      await tx.listingAuditLog.create({
        data: {
          listingId: listing.id,
          action: 'price_updated',
          actorId: request.user.accountId,
          metadata: { oldPrice, newPrice: askingPrice },
        },
      })

      return updatedListing
    },
  )

  return reply.code(200).send(toListingResponse(updated))
}
