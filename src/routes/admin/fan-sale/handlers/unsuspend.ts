// MKPLS-388: POST /v1/admin/fan-sale/sellers/:sellerId/unsuspend
// Clears fanSaleSuspended and writes a SellerFlag audit entry.
// Requires admin JWT role (enforced by requireAdmin preHandler on the route group).

import { FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'

const ParamsSchema = z.object({
  sellerId: z
    .string()
    .regex(/^\d+$/, 'sellerId must be a positive integer')
    .transform(Number),
})

const BodySchema = z.object({
  reason: z.string().min(1, 'reason is required'),
})

export async function unsuspendHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const paramsResult = ParamsSchema.safeParse(request.params)
  if (!paramsResult.success) {
    return reply
      .code(400)
      .send({ error: 'Bad Request', message: paramsResult.error.issues[0].message, statusCode: 400 })
  }

  const bodyResult = BodySchema.safeParse(request.body)
  if (!bodyResult.success) {
    return reply
      .code(400)
      .send({ error: 'Bad Request', message: bodyResult.error.issues[0].message, statusCode: 400 })
  }

  const { sellerId } = paramsResult.data
  const { reason } = bodyResult.data
  const adminId = request.user.accountId
  const prisma = request.server.prisma

  const account = await prisma.sellerPaymentAccount.findUnique({
    where: { sellerId },
    select: { fanSaleSuspended: true },
  })

  if (!account) {
    return reply.code(404).send({ error: 'Not Found', message: 'Seller not found', statusCode: 404 })
  }

  if (!account.fanSaleSuspended) {
    return reply
      .code(409)
      .send({ error: 'Conflict', message: 'Seller is not suspended', statusCode: 409 })
  }

  // Atomic: clear suspension + write audit flag
  await prisma.$transaction([
    prisma.sellerPaymentAccount.update({
      where: { sellerId },
      data: { fanSaleSuspended: false },
    }),
    prisma.sellerFlag.create({
      data: {
        sellerId,
        reason: 'unsuspended',
        actorId: adminId,
        metadata: { adminReason: reason },
      },
    }),
  ])

  return reply.code(200).send({
    sellerId,
    fanSaleSuspended: false,
    unsuspendedBy: adminId,
    reason,
  })
}
