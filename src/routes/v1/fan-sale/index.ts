// Fan Sale route namespace — Phase 0 scaffold
// Each TODO maps to a child ticket of MKPLS-338.
// Routes are registered here but implemented in dedicated handler files per ticket.
//
// NOTE: stub labels MKPLS-348/349 were incorrect — those are frontend tickets.
// Corrected mappings: list = MKPLS-357, single get = included in MKPLS-357.

import { FastifyPluginAsync } from 'fastify'
import { authenticate } from '../../../middleware/authenticate'
import { requireFanSaleEnabled } from '../../../middleware/featureFlag'
import { listingsHandler, getListingHandler } from './handlers/listings'

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
  // MKPLS-357: GET /fan-sale/listings
  // Returns all listings for the authenticated seller, paginated, with status filter.
  // ---------------------------------------------------------------------------
  app.get('/fan-sale/listings', listingsHandler)

  // ---------------------------------------------------------------------------
  // MKPLS-357: GET /fan-sale/listings/:id
  // Returns a single listing by ID. Seller must own the listing (404 on mismatch).
  // ---------------------------------------------------------------------------
  app.get('/fan-sale/listings/:id', getListingHandler)

  // ---------------------------------------------------------------------------
  // MKPLS-358: PATCH /fan-sale/listings/:id — reprice
  // ---------------------------------------------------------------------------
  app.patch('/fan-sale/listings/:id', async (_request, reply) => {
    return reply.code(501).send({ error: 'Not Implemented', message: 'MKPLS-358 pending', statusCode: 501 })
  })

  // ---------------------------------------------------------------------------
  // MKPLS-359: DELETE /fan-sale/listings/:id — delist
  // ---------------------------------------------------------------------------
  app.delete('/fan-sale/listings/:id', async (_request, reply) => {
    return reply.code(501).send({ error: 'Not Implemented', message: 'MKPLS-359 pending', statusCode: 501 })
  })

  // ---------------------------------------------------------------------------
  // MKPLS-353: GET /fan-sale/price-comps
  // ---------------------------------------------------------------------------
  app.get('/fan-sale/price-comps', async (_request, reply) => {
    return reply.code(501).send({ error: 'Not Implemented', message: 'MKPLS-353 pending', statusCode: 501 })
  })

  // ---------------------------------------------------------------------------
  // MKPLS-368: POST /fan-sale/payout/onboard
  // ---------------------------------------------------------------------------
  app.post('/fan-sale/payout/onboard', async (_request, reply) => {
    return reply.code(501).send({ error: 'Not Implemented', message: 'MKPLS-368 pending', statusCode: 501 })
  })

  // ---------------------------------------------------------------------------
  // MKPLS-370: POST /fan-sale/webhooks/adyen
  // Adyen webhook receiver — HMAC-secured, no JWT. See MKPLS-370 branch for
  // the correct implementation using a scoped child plugin (not preHandler: []).
  // ---------------------------------------------------------------------------
  app.post(
    '/fan-sale/webhooks/adyen',
    { preHandler: [] }, // placeholder — see MKPLS-370 branch for correct scoping
    async (_request, reply) => {
      return reply.code(501).send({ error: 'Not Implemented', message: 'MKPLS-370 pending', statusCode: 501 })
    },
  )
}
