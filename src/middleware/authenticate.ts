// MKPLS-343: JWT authentication middleware
// Reads the 'at' cookie (set by vivid-web-athena) or a Bearer token in Authorization header.
// On success, decorates request.user with { accountId, brokerId? }.
// Returns 401 on any verification failure — never leaks JWT internals.

import { FastifyReply, FastifyRequest } from 'fastify'
import { AuthToken } from '../types'

declare module 'fastify' {
  interface FastifyRequest {
    user: { accountId: number; brokerId?: number }
  }
}

export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  try {
    // @fastify/jwt checks the 'at' cookie first (configured in app.ts),
    // then falls back to the Authorization Bearer header.
    await request.jwtVerify()

    const payload = request.user as AuthToken

    if (!payload.accountId) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Invalid token payload', statusCode: 401 })
    }

    // Narrow to the shape routes actually need
    request.user = {
      accountId: payload.accountId,
      ...(payload.brokerId !== undefined && { brokerId: payload.brokerId }),
    }
  } catch {
    return reply.code(401).send({ error: 'Unauthorized', message: 'Authentication required', statusCode: 401 })
  }
}
