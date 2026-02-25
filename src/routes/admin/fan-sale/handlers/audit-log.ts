// MKPLS-362: GET /v1/admin/fan-sale/listings/:id/audit-log
//
// Returns the full mutation history for a listing. Intended for support and
// fraud investigation. Paginated, sorted newest-first. Admin-only.
//
// Query params:
//   page  — 1-based page number (default: 1)
//   limit — records per page (default: 20, max: 100)
//
// 404 when the listing does not exist (no data leak of IDs).
// 200 with empty entries array when listing exists but has no audit log entries.

import { FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'

const QuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

export interface AuditLogEntry {
  id: string
  action: string
  actorId: number
  metadata: unknown
  createdAt: string
}

export interface AuditLogResponse {
  listingId: string
  entries: AuditLogEntry[]
  total: number
  page: number
  limit: number
}

export async function auditLogHandler(
  request: FastifyRequest<{ Params: { id: string }; Querystring: { page?: string; limit?: string } }>,
  reply: FastifyReply,
): Promise<AuditLogResponse> {
  const { id: listingId } = request.params

  const parsed = QuerySchema.safeParse(request.query)
  if (!parsed.success) {
    return reply.code(400).send({
      error: 'Bad Request',
      message: parsed.error.flatten().fieldErrors,
      statusCode: 400,
    })
  }
  const { page, limit } = parsed.data

  // Verify listing exists (avoids leaking valid IDs via 404 vs empty array distinction)
  const listing = await request.server.prisma.fanListing.findUnique({
    where: { id: listingId },
    select: { id: true },
  })
  if (!listing) {
    return reply.code(404).send({
      error: 'Not Found',
      message: 'Listing not found',
      statusCode: 404,
    })
  }

  const [entries, total] = await Promise.all([
    request.server.prisma.listingAuditLog.findMany({
      where: { listingId },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    request.server.prisma.listingAuditLog.count({ where: { listingId } }),
  ])

  return {
    listingId,
    entries: entries.map((e) => ({
      id: e.id,
      action: e.action,
      actorId: e.actorId,
      metadata: e.metadata,
      createdAt: e.createdAt.toISOString(),
    })),
    total,
    page,
    limit,
  }
}
