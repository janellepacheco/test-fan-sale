// Fan Sale route namespace
// Each handler lives in handlers/<ticket>.ts; stubs remain until implemented.

import { FastifyPluginAsync } from 'fastify'
import { authenticate } from '../../../middleware/authenticate'
import { requireFanSaleEnabled } from '../../../middleware/featureFlag'
import { priceCompsHandler } from './handlers/price-comps'

export const fanSaleRoutes: FastifyPluginAsync = async (app) => {
  // Apply feature flag gate and auth to every route in this namespace
  app.addHook('preHandler', requireFanSaleEnabled)
  app.addHook('preHandler', authenticate)

  // ---------------------------------------------------------------------------
  // MKPLS-346: GET /orders/:id/eligible-tickets
  // ---------------------------------------------------------------------------
  app.get('/orders/:id/eligible-tickets', async (_request, reply) => {
    return reply.code(501).send({ error: 'Not Implemented', message: 'MKPLS-346 pending', statusCode: 501 })
  })

  // ---------------------------------------------------------------------------
  // MKPLS-347: POST /fan-sale/listings
  // ---------------------------------------------------------------------------
  app.post('/fan-sale/listings', async (_request, reply) => {
    return reply.code(501).send({ error: 'Not Implemented', message: 'MKPLS-347 pending', statusCode: 501 })
  })

  // ---------------------------------------------------------------------------
  // MKPLS-348: GET /fan-sale/listings
  // ---------------------------------------------------------------------------
  app.get('/fan-sale/listings', async (_request, reply) => {
    return reply.code(501).send({ error: 'Not Implemented', message: 'MKPLS-348 pending', statusCode: 501 })
  })

  // ---------------------------------------------------------------------------
  // MKPLS-349: GET /fan-sale/listings/:id
  // ---------------------------------------------------------------------------
  app.get('/fan-sale/listings/:id', async (_request, reply) => {
    return reply.code(501).send({ error: 'Not Implemented', message: 'MKPLS-349 pending', statusCode: 501 })
  })

  // ---------------------------------------------------------------------------
  // MKPLS-358: PATCH /fan-sale/listings/:id
  // ---------------------------------------------------------------------------
  app.patch('/fan-sale/listings/:id', async (_request, reply) => {
    return reply.code(501).send({ error: 'Not Implemented', message: 'MKPLS-358 pending', statusCode: 501 })
  })

  // ---------------------------------------------------------------------------
  // MKPLS-359: DELETE /fan-sale/listings/:id
  // ---------------------------------------------------------------------------
  app.delete('/fan-sale/listings/:id', async (_request, reply) => {
    return reply.code(501).send({ error: 'Not Implemented', message: 'MKPLS-359 pending', statusCode: 501 })
  })

  // ---------------------------------------------------------------------------
  // MKPLS-353: GET /fan-sale/price-comps
  // ---------------------------------------------------------------------------
  app.get('/fan-sale/price-comps', priceCompsHandler)

  // ---------------------------------------------------------------------------
  // MKPLS-370: POST /fan-sale/webhooks/adyen
  // Adyen webhook receiver — KYC status changes, transfer outcomes.
  // Auth hook bypassed — Adyen signs with HMAC instead of JWT.
  // ---------------------------------------------------------------------------
  app.post(
    '/fan-sale/webhooks/adyen',
    { preHandler: [] },
    async (_request, reply) => {
      return reply.code(501).send({ error: 'Not Implemented', message: 'MKPLS-370 pending', statusCode: 501 })
    },
  )
}
