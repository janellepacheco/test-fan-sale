// MKPLS-362: Admin role gate middleware
// Checks for role: 'admin' in the JWT payload.
// Must run after authenticate() — requires request.user to be populated.
// Returns 403 (not 401) when authenticated but not admin.

import { FastifyRequest, FastifyReply } from 'fastify'

export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const user = request.user as { accountId: number; role?: string }
  if (user?.role !== 'admin') {
    return reply.code(403).send({
      error: 'Forbidden',
      message: 'Admin role required',
      statusCode: 403,
    })
  }
}
