// MKPLS-389: GET /v1/admin/fan-sale/sellers — flagged seller review queue
//
// Returns sellers who have at least one SellerFlag, with their flag summary,
// active listing count, and suspension status. Supports pagination and
// optional ?userId=<number> search.

import { FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'

const QuerySchema = z.object({
  userId: z.string().regex(/^\d+$/).transform(Number).optional(),
  page: z.string().regex(/^\d+$/).transform(Number).default('1'),
  limit: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .refine((n) => n >= 1 && n <= 100, 'limit must be 1–100')
    .default('25'),
})

export async function flaggedSellersHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const queryResult = QuerySchema.safeParse(request.query)
  if (!queryResult.success) {
    return reply.code(400).send({
      error: 'Bad Request',
      message: queryResult.error.issues[0].message,
      statusCode: 400,
    })
  }

  const { userId, page, limit } = queryResult.data
  const offset = (page - 1) * limit
  const prisma = request.server.prisma

  // Aggregate flags grouped by sellerId
  const flagGroups = await prisma.sellerFlag.groupBy({
    by: ['sellerId'],
    _count: { id: true },
    ...(userId !== undefined && { where: { sellerId: userId } }),
    orderBy: { _count: { id: 'desc' } },
    skip: offset,
    take: limit,
  })

  if (flagGroups.length === 0) {
    return reply.code(200).send({ sellers: [], total: 0, page, limit })
  }

  const sellerIds = flagGroups.map((g) => g.sellerId)

  // Fetch flag details, payment accounts, and active listing counts in parallel
  const [flagDetails, accounts, activeCounts] = await Promise.all([
    prisma.sellerFlag.findMany({
      where: { sellerId: { in: sellerIds } },
      select: { sellerId: true, reason: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.sellerPaymentAccount.findMany({
      where: { sellerId: { in: sellerIds } },
      select: { sellerId: true, fanSaleSuspended: true, kycStatus: true },
    }),
    prisma.fanListing.groupBy({
      by: ['sellerId'],
      where: { sellerId: { in: sellerIds }, status: 'ACTIVE' },
      _count: { id: true },
    }),
  ])

  // Index by sellerId for O(1) lookup
  const accountBySeller = new Map(accounts.map((a) => [a.sellerId, a]))
  const activeCountBySeller = new Map(activeCounts.map((c) => [c.sellerId, c._count.id]))
  const flagsBySeller = flagDetails.reduce<
    Map<number, { reason: string; createdAt: Date }[]>
  >((acc, f) => {
    const list = acc.get(f.sellerId) ?? []
    list.push({ reason: f.reason, createdAt: f.createdAt })
    acc.set(f.sellerId, list)
    return acc
  }, new Map())

  // Total count for pagination metadata
  const totalGroups = await prisma.sellerFlag.groupBy({
    by: ['sellerId'],
    _count: { id: true },
    ...(userId !== undefined && { where: { sellerId: userId } }),
  })

  const sellers = flagGroups.map((g) => {
    const account = accountBySeller.get(g.sellerId)
    return {
      sellerId: g.sellerId,
      flagCount: g._count.id,
      flagReasons: [...new Set((flagsBySeller.get(g.sellerId) ?? []).map((f) => f.reason))],
      recentFlags: (flagsBySeller.get(g.sellerId) ?? []).slice(0, 5),
      activeListingCount: activeCountBySeller.get(g.sellerId) ?? 0,
      fanSaleSuspended: account?.fanSaleSuspended ?? false,
      kycStatus: account?.kycStatus ?? null,
    }
  })

  return reply.code(200).send({
    sellers,
    total: totalGroups.length,
    page,
    limit,
  })
}
