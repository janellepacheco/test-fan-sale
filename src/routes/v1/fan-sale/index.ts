// Fan Sale route namespace
// Routes are split into two child scopes so that addHook('preHandler') for JWT
// auth does NOT apply to the Adyen webhook endpoint (which is HMAC-secured instead).
// See: https://fastify.dev/docs/latest/Reference/Hooks/ — parent hooks propagate
// to child scopes, so the only safe way to exclude a route is a sibling scope.
//
//   ┌─ fanSaleRoutes (prefix /v1) ─────────────────────────────────────────┐
//   │  ┌─ webhookScope ───────────────────────────────────────────────────┐ │
//   │  │  POST /fan-sale/webhooks/adyen  (HMAC only, no JWT)             │ │
//   │  │  addContentTypeParser: captures rawBody for HMAC validation      │ │
//   │  └──────────────────────────────────────────────────────────────────┘ │
//   │  ┌─ authScope ──────────────────────────────────────────────────────┐ │
//   │  │  addHook preHandler: requireFanSaleEnabled + authenticate        │ │
//   │  │  … all seller-facing routes …                                    │ │
//   │  └──────────────────────────────────────────────────────────────────┘ │
//   └──────────────────────────────────────────────────────────────────────┘

import { FastifyPluginAsync } from 'fastify'
import { authenticate } from '../../../middleware/authenticate'
import { requireFanSaleEnabled } from '../../../middleware/featureFlag'
import { StubNotificationService } from '../../../services/notifications'
import { makeAdyenWebhookHandler } from './handlers/adyen-webhook'

export const fanSaleRoutes: FastifyPluginAsync = async (app) => {
  // ── Webhook scope — no auth, raw body capture ──────────────────────────────
  // Registered without auth hooks. The custom content type parser saves the raw
  // request bytes so the handler can validate Adyen's HMAC-SHA256 signature.
  await app.register(async (webhookApp) => {
    webhookApp.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (req, body, done) => {
        // Attach raw bytes before JSON parse — used by HMAC validation
        ;(req as typeof req & { rawBody: Buffer }).rawBody = body
        try {
          done(null, JSON.parse(body.toString()))
        } catch (err) {
          done(err as Error)
        }
      },
    )

    // MKPLS-370: Adyen KYC / account holder status webhook
    const notificationService = new StubNotificationService()
    webhookApp.post('/fan-sale/webhooks/adyen', makeAdyenWebhookHandler(notificationService))
  })

  // ── Authenticated scope — JWT + feature flag on every route ───────────────
  await app.register(async (authApp) => {
    authApp.addHook('preHandler', requireFanSaleEnabled)
    authApp.addHook('preHandler', authenticate)

    // ---------------------------------------------------------------------------
    // MKPLS-346: GET /orders/:id/eligible-tickets
    // Returns tickets from the authenticated user's order that are eligible
    // for Fan Sale listing. Source is unrestricted — VS, StubHub, TM, AXS, etc.
    // ---------------------------------------------------------------------------
    authApp.get('/orders/:id/eligible-tickets', async (_request, reply) => {
      return reply.code(501).send({ error: 'Not Implemented', message: 'MKPLS-346 pending', statusCode: 501 })
    })

    // ---------------------------------------------------------------------------
    // MKPLS-347: POST /fan-sale/listings
    // ---------------------------------------------------------------------------
    authApp.post('/fan-sale/listings', async (_request, reply) => {
      return reply.code(501).send({ error: 'Not Implemented', message: 'MKPLS-347 pending', statusCode: 501 })
    })

    // ---------------------------------------------------------------------------
    // MKPLS-348: GET /fan-sale/listings
    // ---------------------------------------------------------------------------
    authApp.get('/fan-sale/listings', async (_request, reply) => {
      return reply.code(501).send({ error: 'Not Implemented', message: 'MKPLS-348 pending', statusCode: 501 })
    })

    // ---------------------------------------------------------------------------
    // MKPLS-349: GET /fan-sale/listings/:id
    // ---------------------------------------------------------------------------
    authApp.get('/fan-sale/listings/:id', async (_request, reply) => {
      return reply.code(501).send({ error: 'Not Implemented', message: 'MKPLS-349 pending', statusCode: 501 })
    })

    // ---------------------------------------------------------------------------
    // MKPLS-358: PATCH /fan-sale/listings/:id
    // Price update — reprices an ACTIVE listing. Writes audit log entry.
    // ---------------------------------------------------------------------------
    authApp.patch('/fan-sale/listings/:id', async (_request, reply) => {
      return reply.code(501).send({ error: 'Not Implemented', message: 'MKPLS-358 pending', statusCode: 501 })
    })

    // ---------------------------------------------------------------------------
    // MKPLS-359: DELETE /fan-sale/listings/:id
    // Soft-deletes (DELISTED) an ACTIVE listing. Writes audit log entry.
    // ---------------------------------------------------------------------------
    authApp.delete('/fan-sale/listings/:id', async (_request, reply) => {
      return reply.code(501).send({ error: 'Not Implemented', message: 'MKPLS-359 pending', statusCode: 501 })
    })

    // ---------------------------------------------------------------------------
    // MKPLS-353: GET /fan-sale/price-comps
    // ---------------------------------------------------------------------------
    authApp.get('/fan-sale/price-comps', async (_request, reply) => {
      return reply.code(501).send({ error: 'Not Implemented', message: 'MKPLS-353 pending', statusCode: 501 })
    })

    // ---------------------------------------------------------------------------
    // MKPLS-368: POST /fan-sale/payout/onboard
    // ---------------------------------------------------------------------------
    authApp.post('/fan-sale/payout/onboard', async (_request, reply) => {
      return reply.code(501).send({ error: 'Not Implemented', message: 'MKPLS-368 pending', statusCode: 501 })
    })
  })
}
