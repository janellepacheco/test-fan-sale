// MKPLS-386: preHandler that blocks re-listing of an already-active ticket.
// Runs after authenticate() on POST /fan-sale/listings.
// Checks for an ACTIVE listing with the same barcodeHash before allowing create.

import { FastifyReply, FastifyRequest } from 'fastify'
import { generateBarcodeHash } from '../services/barcode-hash'

export async function checkBarcodeDedup(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const body = request.body as { ticketId?: string; seatNumber?: string }

  // If required fields are absent, pass through — body validation is the create handler's job
  if (!body?.ticketId) return

  const seatNumbers = body.seatNumber ? [body.seatNumber] : []
  const hash = generateBarcodeHash(body.ticketId, seatNumbers)

  const duplicate = await request.server.prisma.fanListing.findFirst({
    where: { barcodeHash: hash, status: 'ACTIVE' },
    select: { id: true },
  })

  if (duplicate) {
    return reply.code(409).send({
      error: 'Conflict',
      message: 'This ticket is already listed for sale',
      statusCode: 409,
    })
  }
}
