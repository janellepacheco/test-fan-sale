// MKPLS-362 + MKPLS-388: Admin role gate.
// Verifies JWT and checks role === 'admin'. Returns 403 (not 401) for authenticated
// but non-admin users — intentional: we don't reveal whether the endpoint exists.

import { FastifyReply, FastifyRequest } from 'fastify'

export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  try {
    await request.jwtVerify()

    const payload = request.user as { accountId?: number; role?: string }

    if (!payload.accountId || payload.role !== 'admin') {
      return reply
        .code(403)
        .send({ error: 'Forbidden', message: 'Admin role required', statusCode: 403 })
    }

    // Narrow request.user to what admin handlers need
    request.user = { accountId: payload.accountId }
  } catch {
    return reply
      .code(403)
      .send({ error: 'Forbidden', message: 'Admin role required', statusCode: 403 })
  }
}
