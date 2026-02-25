// MKPLS-357: GET /v1/fan-sale/listings  — paginated list of all seller's listings
//            GET /v1/fan-sale/listings/:id — single listing by ID (ownership enforced)
//
// Both endpoints use 404 for "not found" AND "wrong owner" — no existence leak.

import { FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { toListingResponse } from '../../../lib/listing'
import { ListingResponse } from '../../../types'

// ---------------------------------------------------------------------------
// GET /fan-sale/listings
// ---------------------------------------------------------------------------

const ListingsQuerySchema = z.object({
  // Client sends lowercase status values per Jira AC; we uppercase for the enum.
  status: z
    .string()
    .optional()
    .transform((v) => v?.toUpperCase())
    .pipe(
      z
        .enum(['ACTIVE', 'SOLD', 'DELISTED', 'EXPIRED', 'FULFILLED'])
        .optional(),
    ),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

export interface ListingsResponse {
  listings: ListingResponse[]
  total: number
  page: number
  limit: number
}

export async function listingsHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<ListingsResponse> {
  const parsed = ListingsQuerySchema.safeParse(request.query)
  if (!parsed.success) {
    return reply.code(400).send({
      error: 'Bad Request',
      message: parsed.error.errors[0]?.message ?? 'Invalid query parameters',
      statusCode: 400,
    })
  }

  const { status, page, limit } = parsed.data
  const { accountId: sellerId } = request.user as { accountId: number }
  const where = { sellerId, ...(status ? { status } : {}) }

  const [rows, total] = await request.server.prisma.$transaction([
    request.server.prisma.fanListing.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    request.server.prisma.fanListing.count({ where }),
  ])

  return { listings: rows.map(toListingResponse), total, page, limit }
}

// ---------------------------------------------------------------------------
// GET /fan-sale/listings/:id
// ---------------------------------------------------------------------------

export async function getListingHandler(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<ListingResponse> {
  const { id } = request.params
  const { accountId: sellerId } = request.user as { accountId: number }

  // findFirst with both id + sellerId collapses "not found" and "wrong owner"
  // into a single 404 — no existence leak to non-owners.
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

  return toListingResponse(listing)
}
