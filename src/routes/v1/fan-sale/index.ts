// Fan Sale route namespace — Phase 0 scaffold
// Each TODO maps to a child ticket of MKPLS-338.
// Routes are registered here but implemented in dedicated handler files per ticket.

import { FastifyPluginAsync } from 'fastify'
import { authenticate } from '../../../middleware/authenticate'
import { requireFanSaleEnabled } from '../../../middleware/featureFlag'
import { requireNotSuspended } from '../../../middleware/requireNotSuspended'
import { checkBarcodeDedup } from '../../../middleware/checkBarcodeDedup'
import { checkListingCap } from '../../../middleware/checkListingCap'
import { rateLimitMiddleware } from '../../../middleware/rateLimit'

export const fanSaleRoutes: FastifyPluginAsync = async (app) => {
  // Apply feature flag gate and auth to every route in this namespace
  app.addHook('preHandler', requireFanSaleEnabled)
  app.addHook('preHandler', authenticate)

  // ---------------------------------------------------------------------------
  // MKPLS-346: GET /orders/:id/eligible-tickets
  // Returns tickets from the authenticated user's order that are eligible
  // for Fan Sale listing. Source is unrestricted — VS, StubHub, TM, AXS, etc.
  // ---------------------------------------------------------------------------
  app.get('/orders/:id/eligible-tickets', async (_request, reply) => {
    return reply.code(501).send({ error: 'Not Implemented', message: 'MKPLS-346 pending', statusCode: 501 })
  })

  // ---------------------------------------------------------------------------
  // MKPLS-347: POST /fan-sale/listings
  // Creates a new fan listing. Validates: seller velocity (≤10 active),
  // barcode dedup, asking price within allowed range, ticket ownership.
  // MKPLS-386: checkBarcodeDedup — 409 if ticket already ACTIVE.
  // MKPLS-387: checkListingCap — 429 if ≥10 active; rateLimitMiddleware — 429 if >5/hr.
  // MKPLS-388: requireNotSuspended gate — 403 if fanSaleSuspended=true.
  // ---------------------------------------------------------------------------
  app.post(
    '/fan-sale/listings',
    { preHandler: [requireNotSuspended, checkListingCap, rateLimitMiddleware, checkBarcodeDedup] },
    async (_request, reply) => {
    return reply.code(501).send({ error: 'Not Implemented', message: 'MKPLS-347 pending', statusCode: 501 })
  })

  // ---------------------------------------------------------------------------
  // MKPLS-348: GET /fan-sale/listings
  // Returns all listings for the authenticated seller.
  // ---------------------------------------------------------------------------
  app.get('/fan-sale/listings', async (_request, reply) => {
    return reply.code(501).send({ error: 'Not Implemented', message: 'MKPLS-348 pending', statusCode: 501 })
  })

  // ---------------------------------------------------------------------------
  // MKPLS-349: GET /fan-sale/listings/:id
  // Returns a single listing by ID. Seller must own the listing.
  // ---------------------------------------------------------------------------
  app.get('/fan-sale/listings/:id', async (_request, reply) => {
    return reply.code(501).send({ error: 'Not Implemented', message: 'MKPLS-349 pending', statusCode: 501 })
  })

  // ---------------------------------------------------------------------------
  // MKPLS-358: PATCH /fan-sale/listings/:id
  // Price update — reprices an ACTIVE listing. Writes audit log entry.
  // ---------------------------------------------------------------------------
  app.patch('/fan-sale/listings/:id', async (_request, reply) => {
    return reply.code(501).send({ error: 'Not Implemented', message: 'MKPLS-358 pending', statusCode: 501 })
  })

  // ---------------------------------------------------------------------------
  // MKPLS-359: DELETE /fan-sale/listings/:id
  // Soft-deletes (DELISTED) an ACTIVE listing. Writes audit log entry.
  // ---------------------------------------------------------------------------
  app.delete('/fan-sale/listings/:id', async (_request, reply) => {
    return reply.code(501).send({ error: 'Not Implemented', message: 'MKPLS-359 pending', statusCode: 501 })
  })

  // ---------------------------------------------------------------------------
  // MKPLS-353: GET /fan-sale/price-comps
  // Returns comparable active listings for an event/section, plus
  // suggestedPrice (median), minPrice, maxPrice to help sellers price fairly.
  // ---------------------------------------------------------------------------
  app.get('/fan-sale/price-comps', async (_request, reply) => {
    return reply.code(501).send({ error: 'Not Implemented', message: 'MKPLS-353 pending', statusCode: 501 })
  })

  // ---------------------------------------------------------------------------
  // MKPLS-370: POST /fan-sale/webhooks/adyen
  // Adyen webhook receiver — KYC status changes, transfer outcomes.
  // Validates HMAC before processing. Auth hook is bypassed for this route
  // (registered after addHook so it overrides with its own preHandler).
  // ---------------------------------------------------------------------------
  app.post(
    '/fan-sale/webhooks/adyen',
    { preHandler: [] }, // No JWT auth — Adyen signs with HMAC instead
    async (_request, reply) => {
      return reply.code(501).send({ error: 'Not Implemented', message: 'MKPLS-370 pending', statusCode: 501 })
    },
  )
}
