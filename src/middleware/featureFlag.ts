// MKPLS-340: Feature flag gate — backend guard for the Fan Sale API
// Paired with the Optimizely fanSaleEnabled flag in vivid-web-athena.
// When FAN_SALE_ENABLED=false, all /v1/fan-sale/* routes return 503.
// This lets us deploy the service before the feature is publicly live.

import { FastifyReply, FastifyRequest } from 'fastify'
import { env } from '../plugins/env'

export async function requireFanSaleEnabled(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!env.FAN_SALE_ENABLED) {
    return reply.code(503).send({
      error: 'Service Unavailable',
      message: 'Fan Sale is not currently enabled',
      statusCode: 503,
    })
  }
}
