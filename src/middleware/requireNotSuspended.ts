// MKPLS-388: preHandler that blocks fan sale actions for suspended sellers.
// Applied to POST /fan-sale/listings (create) — runs after authenticate().

import { FastifyReply, FastifyRequest } from 'fastify'

export async function requireNotSuspended(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { accountId } = request.user

  const account = await request.server.prisma.sellerPaymentAccount.findUnique({
    where: { sellerId: accountId },
    select: { fanSaleSuspended: true },
  })

  if (account?.fanSaleSuspended) {
    return reply.code(403).send({
      error: 'Forbidden',
      message: 'Account suspended from Fan Sale',
      statusCode: 403,
    })
  }
}
