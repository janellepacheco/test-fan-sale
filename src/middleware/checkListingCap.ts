// MKPLS-387: preHandler enforcing max 10 active listings per seller.
// Returns 429 with a listing-cap-specific message (distinct from rate limit 429).

import { FastifyReply, FastifyRequest } from 'fastify'

export const LISTING_CAP = 10

export async function checkListingCap(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { accountId } = request.user

  const activeCount = await request.server.prisma.fanListing.count({
    where: { sellerId: accountId, status: 'ACTIVE' },
  })

  if (activeCount >= LISTING_CAP) {
    return reply.code(429).send({
      error: 'Too Many Requests',
      message: `Listing cap reached. You may have at most ${LISTING_CAP} active listings.`,
      statusCode: 429,
      code: 'LISTING_CAP_EXCEEDED',
    })
  }
}
