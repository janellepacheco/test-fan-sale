// MKPLS-343: JWT authentication middleware
// Accepts tokens via x-auth-token header (hermes pattern used by vivid-web-athena)
// or Authorization: Bearer as a fallback for direct API callers.
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
    // vivid-web-athena sends the token as x-auth-token (same pattern as hermes).
    // Fall back to Authorization: Bearer for direct API callers / tests.
    const xAuthToken = request.headers['x-auth-token'] as string | undefined
    if (xAuthToken) {
      request.headers['authorization'] = `Bearer ${xAuthToken}`
    }

    await request.jwtVerify()

    const payload = request.user as AuthToken

    if (!payload.accountId) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Invalid token payload', statusCode: 401 })
    }

    request.user = {
      accountId: payload.accountId,
      ...(payload.brokerId !== undefined && { brokerId: payload.brokerId }),
    }
  } catch {
    return reply.code(401).send({ error: 'Unauthorized', message: 'Authentication required', statusCode: 401 })
  }
}
